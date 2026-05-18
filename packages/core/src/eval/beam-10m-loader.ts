/**
 * BEAM-10M dataset loader (T3.1 scaffold).
 *
 * Source: HuggingFace `Mohammadta/BEAM-10M` (200 questions / 10 conversations).
 * The 10M tier averages ~1.4M tokens of conversation context per system —
 * the highest-difficulty BEAM tier and the SOTA target for this sprint.
 *
 * This loader is a *stub*: it returns the typed shape for tests and the
 * smoke design without invoking the HuggingFace API. Real loading lives
 * in `atomicmemory-benchmarks/atomicbench/src/eval/` once the loader is
 * promoted out of the worktree.
 */

/** A single ingest-time message in a session. */
export interface Beam10MMessage {
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp anchoring the turn for temporal queries. */
  timestamp: string;
}

/** One session = one chunked conversation segment with shared time anchor. */
export interface Beam10MSession {
  /** Stable session id used as both ingest scope and summary key. */
  sessionId: string;
  /** 0-based position within the parent conversation. */
  sessionIndex: number;
  /** ISO date the session started (for temporal RRF arm). */
  startedAt: string;
  /** Ordered messages in this session. */
  messages: Beam10MMessage[];
}

/** A BEAM probing question — same shape across all tiers. */
export interface Beam10MQuestion {
  /** Stable id (e.g. `c1-q3-KU`). */
  id: string;
  /** BEAM ability category; one of the 10 standard codes. */
  ability:
    | 'ABS' | 'CR' | 'EO' | 'IE' | 'IF'
    | 'KU' | 'MSR' | 'PF' | 'SUM' | 'TR';
  /** Question text. */
  question: string;
  /** Ground-truth answer / rubric anchor — used by the judge. */
  ideal: string;
  /** Optional per-rubric criteria the judge scores. */
  rubric: string[];
}

/** One conversation = many sessions + a fixed set of probing questions. */
export interface Beam10MConversation {
  /** 1-based conversation id (matches Mem0's published numbering). */
  conversationId: number;
  /** Ordered sessions; ingest happens session-by-session. */
  sessions: Beam10MSession[];
  /** 20 probing questions per conversation × 10 conversations = 200 total. */
  questions: Beam10MQuestion[];
  /** Approximate total tokens of conversation transcript (≈ 1.4M for 10M tier). */
  approxTokens: number;
}

/** The full BEAM-10M dataset as returned by the loader. */
export interface Beam10MDataset {
  schemaVersion: 'beam-10m.v1';
  /** Tier identifier. */
  tier: '10M';
  conversations: Beam10MConversation[];
  /** Total question count across all conversations (200 in the canonical set). */
  totalQuestions: number;
}

export interface LoadBeam10MOptions {
  /** Limit to first N questions per conversation (for smoke / cost control). */
  sliceSize?: number;
  /** Restrict to specific conversation ids (e.g. [1] for conv-1 smoke). */
  conversationIds?: number[];
}

/**
 * Resolve the on-disk normalized JSON cache path. Set
 * `BEAM_10M_NORMALIZED_PATH` to override (used by tests + the in-tree
 * `atomicmemory-benchmarks/data/beam-10m/preprocess.py` output).
 */
function resolveCachePath(): string | undefined {
  const env = process.env.BEAM_10M_NORMALIZED_PATH;
  if (env) return env;
  // Default: sibling repo path. The harness runs from the benchmarks repo
  // so this resolves correctly when invoked through atomicbench.
  const candidate = '/Users/moralespanitz/me/supernet/atomicmemory-benchmarks/data/beam-10m/beam-10m-normalized.json';
  return candidate;
}

/**
 * Load the BEAM-10M dataset. If the normalized JSON cache produced by
 * `atomicmemory-benchmarks/data/beam-10m/preprocess.py` exists at the
 * resolved path, parses it and returns the real dataset. Otherwise falls
 * back to a deterministic stub fixture matching the canonical
 * 10-conversation × 20-question shape, so tests and cost-estimator code
 * keep working without the ~344 MB parquet shards on disk.
 */
export async function loadBeam10MDataset(
  opts: LoadBeam10MOptions = {},
): Promise<Beam10MDataset> {
  const allConversations = await loadConversationsOrStub();
  const filtered = opts.conversationIds && opts.conversationIds.length > 0
    ? allConversations.filter((c) => opts.conversationIds!.includes(c.conversationId))
    : allConversations;
  const sliced = opts.sliceSize !== undefined
    ? filtered.map((c) => ({ ...c, questions: c.questions.slice(0, opts.sliceSize!) }))
    : filtered;
  const totalQuestions = sliced.reduce((sum, c) => sum + c.questions.length, 0);
  return {
    schemaVersion: 'beam-10m.v1',
    tier: '10M',
    conversations: sliced,
    totalQuestions,
  };
}

async function loadConversationsOrStub(): Promise<Beam10MConversation[]> {
  const cachePath = resolveCachePath();
  if (!cachePath) return buildStubFixture();
  try {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as { conversations?: Beam10MConversation[] };
    if (!parsed.conversations || !Array.isArray(parsed.conversations)) {
      return buildStubFixture();
    }
    return parsed.conversations;
  } catch {
    return buildStubFixture();
  }
}

/**
 * Cost projection for a given dataset slice. Used by the smoke plan to
 * estimate per-seed cost before committing the full multirun budget.
 *
 * Cost components per system per question:
 *   - ingest (one-time): ~$0.002/fact × ~150 facts/conv = $0.30/conv
 *   - summary generation (hierarchical only): ~$0.001/session × 50 sessions = $0.05/conv
 *   - search + answer + judge: ~$0.10/question (multi-iter)
 *
 * Per-conv: ~$2 ingest + $2 questions = ~$4/conv. 10 convs = ~$40/seed.
 * The smoke (conv-1 × 20 q) is ~$4. n=3 multirun on full set = ~$120.
 */
export function estimateBeamCost(dataset: Beam10MDataset, opts: { hierarchicalEnabled?: boolean } = {}): {
  ingestUsd: number;
  summaryUsd: number;
  questionsUsd: number;
  totalUsd: number;
} {
  const convCount = dataset.conversations.length;
  const factsPerConv = 150; // empirical average from BEAM-100K
  const sessionsPerConv = 50;
  const questionsTotal = dataset.totalQuestions;

  const ingestUsd = convCount * factsPerConv * 0.002;
  const summaryUsd = opts.hierarchicalEnabled
    ? convCount * sessionsPerConv * 0.001 + convCount * 0.005
    : 0;
  const questionsUsd = questionsTotal * 0.10;
  const totalUsd = ingestUsd + summaryUsd + questionsUsd;
  return { ingestUsd, summaryUsd, questionsUsd, totalUsd };
}

/**
 * Stub fixture: 10 conversations × 1 session × 1 message + 20 placeholder
 * questions per conversation. Real data has ~50 sessions × ~30 messages
 * each per conversation; this stub gives the shape only.
 */
function buildStubFixture(): Beam10MConversation[] {
  const convs: Beam10MConversation[] = [];
  for (let cid = 1; cid <= 10; cid += 1) {
    const sessions: Beam10MSession[] = [
      {
        sessionId: `c${cid}-s0`,
        sessionIndex: 0,
        startedAt: '2026-01-01T00:00:00Z',
        messages: [
          { role: 'user', content: `placeholder-c${cid}-msg`, timestamp: '2026-01-01T00:00:00Z' },
        ],
      },
    ];
    const questions: Beam10MQuestion[] = [];
    const abilities: Beam10MQuestion['ability'][] = [
      'ABS', 'CR', 'EO', 'IE', 'IF', 'KU', 'MSR', 'PF', 'SUM', 'TR',
    ];
    for (let qi = 1; qi <= 20; qi += 1) {
      const ability = abilities[(qi - 1) % abilities.length];
      questions.push({
        id: `c${cid}-q${qi}-${ability}`,
        ability,
        question: `placeholder-question-${qi}`,
        ideal: `placeholder-answer-${qi}`,
        rubric: [],
      });
    }
    convs.push({ conversationId: cid, sessions, questions, approxTokens: 1_400_000 });
  }
  return convs;
}
