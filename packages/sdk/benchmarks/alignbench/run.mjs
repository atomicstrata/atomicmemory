#!/usr/bin/env node
/**
 * AlignBench runner — standalone, no SDK/Postgres/network required.
 *
 * Embeds every fact in each axis, embeds every query, scores cosine similarity,
 * reports recall@1 / recall@5 / mean-gold-rank / false-positive@5 per axis,
 * and writes a single run JSON.
 *
 * Variants are switched via flags; the underlying scoring is identical so
 * results are directly comparable across runs.
 *
 *   node run.mjs                                  # baseline (current SDK stack)
 *   node run.mjs --variant=query-rewrite          # rewrite pronouns in query
 *   node run.mjs --variant=dual-storage           # store fact in both forms
 *   node run.mjs --variant=hybrid-bm25            # BM25 + semantic union
 *   node run.mjs --variant=combined               # query-rewrite + hybrid-bm25
 *
 *   node run.mjs --out=runs/baseline.json --model=Xenova/all-MiniLM-L6-v2
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@huggingface/transformers';

// -- CLI --
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const VARIANT = args.variant ?? 'baseline';
const MODEL = args.model ?? 'Xenova/all-MiniLM-L6-v2';
const TOPK = Number(args.topk ?? 5);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = args.out ?? path.join(HERE, 'runs', `${VARIANT}.json`);

// -- Load manifest --
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'items.json'), 'utf8'));

// -- Variant: query rewrite --
// Deterministic pronoun substitution to bridge first-person → third-person.
// Order matters: longer phrases first so we don't double-substitute.
const PRONOUN_RULES = [
  [/\bmy\b/gi, "the user's"],
  [/\bme\b/gi, 'the user'],
  [/\bI am\b/gi, 'the user is'],
  [/\bI'm\b/gi, 'the user is'],
  [/\bI've\b/gi, 'the user has'],
  [/\bI'd\b/gi, 'the user would'],
  [/\bI'll\b/gi, 'the user will'],
  [/\bI\b/gi, 'the user'],
  [/\bmyself\b/gi, 'the user'],
];
function rewriteQueryPronouns(q) {
  let out = q;
  for (const [re, repl] of PRONOUN_RULES) out = out.replace(re, repl);
  return out;
}

// -- Variant: dual storage --
// For each fact, also produce a first-person paraphrase. Both are stored;
// retrieval picks whichever scores higher.
const STORE_RULES = [
  [/\bThe user's\b/g, 'My'],
  [/\bthe user's\b/g, 'my'],
  [/\bThe user\b/g, 'I'],
  [/\bthe user\b/g, 'I'],
];
function paraphraseFirstPerson(fact) {
  let out = fact;
  for (const [re, repl] of STORE_RULES) out = out.replace(re, repl);
  // tidy common verb agreements after subject rewrite (avoid worst surface mismatches)
  out = out.replace(/\bI is\b/g, 'I am').replace(/\bI has\b/g, 'I have').replace(/\bI does\b/g, 'I do');
  return out;
}

// -- Hybrid BM25 implementation (tiny, just for this benchmark) --
function tokenize(s) {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
function bm25Scores(queryTokens, docsTokens, k1 = 1.5, b = 0.75) {
  const N = docsTokens.length;
  const avgDL = docsTokens.reduce((a, d) => a + d.length, 0) / Math.max(1, N);
  const df = new Map();
  for (const doc of docsTokens) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (t) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  return docsTokens.map((doc) => {
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = doc.length;
    let score = 0;
    for (const qt of new Set(queryTokens)) {
      const f = tf.get(qt) ?? 0;
      if (f === 0) continue;
      score += idf(qt) * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgDL))));
    }
    return score;
  });
}
function minmaxNormalize(arr) {
  let lo = Infinity, hi = -Infinity;
  for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo;
  if (span <= 0) return arr.map(() => 0);
  return arr.map((v) => (v - lo) / span);
}

// -- Cosine --
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const m = Math.sqrt(na * nb);
  return m === 0 ? 0 : dot / m;
}

// -- Embedder --
async function loadEmbedder(model) {
  console.log(`[load] ${model}`);
  const fn = await pipeline('feature-extraction', model);
  return async (text) => {
    const out = await fn(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  };
}

// -- Build the global fact pool used for ALL queries --
// Real SDK stores are mixed: facts from all topics, plus extraction-style meta-facts
// that pollute the embedding space. The realistic test is "can the right user-fact
// outrank the distractors when they all live in the same store".
function buildGlobalPool(manifest, variant) {
  // {axisName: [{text, globalKey}]}. globalKey is the canonical id used for gold matching.
  const entries = []; // [{ text, globalKey, axis, factIndex, isDistractor }]
  for (const [axisName, body] of Object.entries(manifest.axes)) {
    const isDistractor = axisName === 'distractors';
    for (let i = 0; i < body.facts.length; i++) {
      const globalKey = `${axisName}#${i}`;
      entries.push({ text: body.facts[i], globalKey, axis: axisName, factIndex: i, isDistractor });
      if (variant === 'dual-storage' || variant === 'combined') {
        const para = paraphraseFirstPerson(body.facts[i]);
        if (para !== body.facts[i]) {
          entries.push({ text: para, globalKey, axis: axisName, factIndex: i, isDistractor });
        }
      }
    }
  }
  return entries;
}

async function scoreAxis(axisName, axisBody, embed, pool, factVecs, factTokens) {
  const perItem = [];
  let hitAt1 = 0, hitAt5 = 0;
  let goldRankSum = 0, goldRankN = 0;
  let distractorTop1 = 0;
  let fpAt5 = 0;
  const marginSamples = []; // gold_score - best_non_gold_score

  for (const item of axisBody.items) {
    const origQ = item.query;
    let effQ = origQ;
    if (VARIANT === 'query-rewrite' || VARIANT === 'combined') {
      effQ = rewriteQueryPronouns(origQ);
    }
    const qVec = await embed(effQ);
    const semScores = factVecs.map((fv) => cosine(qVec, fv));
    let scores = semScores;
    if (VARIANT === 'hybrid-bm25' || VARIANT === 'combined') {
      const qTokens = tokenize(effQ);
      const bm = bm25Scores(qTokens, factTokens);
      const semN = minmaxNormalize(semScores);
      const bmN = minmaxNormalize(bm);
      scores = semN.map((s, i) => 0.6 * s + 0.4 * bmN[i]);
    }

    // Rank, collapse to globalKey (dual-storage duplicates same key)
    const ranked = scores
      .map((s, i) => ({ s, entry: pool[i] }))
      .sort((a, b) => b.s - a.s);
    const seen = new Set();
    const dedup = [];
    for (const r of ranked) {
      if (seen.has(r.entry.globalKey)) continue;
      seen.add(r.entry.globalKey);
      dedup.push(r);
    }
    const topK = dedup.slice(0, TOPK);

    // Gold match: same axis + same factIndex
    let goldRank = null;
    let goldScore = null;
    const goldKey = (item.fact_index != null) ? `${axisName}#${item.fact_index}` : null;
    if (item.gold_in_topk && goldKey) {
      const idx = dedup.findIndex((r) => r.entry.globalKey === goldKey);
      if (idx >= 0) { goldRank = idx + 1; goldScore = dedup[idx].s; }
    }

    // Margin: gold vs best non-gold
    if (goldScore !== null) {
      const bestNonGold = dedup.find((r) => r.entry.globalKey !== goldKey);
      if (bestNonGold) marginSamples.push(goldScore - bestNonGold.s);
    }

    const hit1 = goldRank === 1;
    const hit5 = goldRank !== null && goldRank <= TOPK;
    if (hit1) hitAt1++;
    if (hit5) hitAt5++;
    if (goldRank !== null) { goldRankSum += goldRank; goldRankN++; }

    // Distractor-pollution metric: how often a meta-fact ranks top-1
    if (item.gold_in_topk && topK[0]?.entry.isDistractor) distractorTop1++;

    let fp = false;
    if (item.gold_in_topk === false) {
      fp = topK.length > 0 && topK[0].s > 0.5;
      if (fp) fpAt5++;
    }

    perItem.push({
      id: item.id,
      query: origQ,
      effective_query: effQ,
      gold_in_topk: item.gold_in_topk ?? false,
      gold_global_key: goldKey,
      gold_rank: goldRank,
      gold_score: goldScore,
      top1_text: topK[0]?.entry.text ?? null,
      top1_score: topK[0]?.s ?? null,
      top1_is_distractor: topK[0]?.entry.isDistractor ?? false,
      false_positive: fp,
    });
  }

  const n = axisBody.items.length;
  return {
    axis: axisName,
    n,
    pool_size: pool.length,
    recall_at_1: n > 0 ? hitAt1 / n : null,
    recall_at_5: n > 0 ? hitAt5 / n : null,
    mean_gold_rank: goldRankN > 0 ? goldRankSum / goldRankN : null,
    distractor_at_top1: distractorTop1,
    false_positive_count: fpAt5,
    median_gold_margin: marginSamples.length > 0
      ? marginSamples.sort((a, b) => a - b)[Math.floor(marginSamples.length / 2)]
      : null,
    items: perItem,
  };
}

// -- Main --
async function main() {
  const t0 = Date.now();
  const embed = await loadEmbedder(MODEL);

  // Build the SHARED global pool — every query competes against the full set,
  // including extraction-style distractor meta-facts.
  const pool = buildGlobalPool(manifest, VARIANT);
  console.log(`[pool] ${pool.length} entries (variant=${VARIANT})`);
  const factVecs = [];
  for (const e of pool) factVecs.push(await embed(e.text));
  const factTokens = pool.map((e) => tokenize(e.text));

  const results = [];
  for (const [axisName, body] of Object.entries(manifest.axes)) {
    if (body.items.length === 0) continue; // skip distractor section (facts only)
    process.stdout.write(`[axis] ${axisName.padEnd(13)} ... `);
    const r = await scoreAxis(axisName, body, embed, pool, factVecs, factTokens);
    process.stdout.write(`r@5=${r.recall_at_5?.toFixed(3) ?? 'n/a'}  r@1=${r.recall_at_1?.toFixed(3) ?? 'n/a'}  margin=${r.median_gold_margin?.toFixed(3) ?? 'n/a'}  distractor_top1=${r.distractor_at_top1}\n`);
    results.push(r);
  }

  // Composite (excluding control)
  const scoredAxes = results.filter((r) => r.axis !== 'control');
  const totalN = scoredAxes.reduce((a, r) => a + r.n, 0);
  const composite = {
    recall_at_1: scoredAxes.reduce((a, r) => a + r.recall_at_1 * r.n, 0) / totalN,
    recall_at_5: scoredAxes.reduce((a, r) => a + r.recall_at_5 * r.n, 0) / totalN,
    distractor_top1_rate: scoredAxes.reduce((a, r) => a + r.distractor_at_top1, 0) / totalN,
    n: totalN,
  };
  const controlAxis = results.find((r) => r.axis === 'control');
  const fpRate = controlAxis ? controlAxis.false_positive_count / controlAxis.n : null;

  const out = {
    variant: VARIANT,
    model: MODEL,
    topk: TOPK,
    wall_seconds: ((Date.now() - t0) / 1000).toFixed(1),
    composite,
    false_positive_rate: fpRate,
    per_axis: results,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`composite  r@1 = ${composite.recall_at_1.toFixed(3)}   r@5 = ${composite.recall_at_5.toFixed(3)}`);
  console.log(`distractor_top1_rate = ${composite.distractor_top1_rate.toFixed(3)}    fp@control = ${fpRate?.toFixed(3) ?? 'n/a'}`);
  console.log(`saved → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
