/**
 * @file Pure-function tests for the hook content sanitizers ported from
 * the shell hook helpers. End-to-end coverage that wires these into the
 * `post-compact` / `stop` hook handlers lives in `hooks-command.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanCompactSummaryText,
  cleanSummaryText,
  redactSecrets,
  sanitizePromptContext,
  stripUnsafeModelBlocks,
  truncate,
} from '../commands/setup/hooks/sanitize.js';

test('redactSecrets masks OpenAI-style sk- keys', () => {
  const out = redactSecrets('see sk-abcdef0123456789ABCDEF for prod');
  assert.match(out, /sk-\[redacted\]/);
  assert.equal(/abcdef0123456789ABCDEF/.test(out), false);
});

test('redactSecrets masks AKIA access key IDs', () => {
  const out = redactSecrets('AKIAIOSFODNN7' + 'EXAMPLE');
  assert.equal(out, 'AKIA[redacted]');
});

test('redactSecrets strips basic-auth credentials embedded in URLs', () => {
  const out = redactSecrets('connect to https://user:topsecret@db.example.com/x');
  assert.equal(out, 'connect to https://[redacted]@db.example.com/x');
});

test('redactSecrets masks long opaque uppercase tokens', () => {
  const out = redactSecrets('token AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA followed');
  assert.match(out, /\[redacted-token\]/);
});

test('truncate trims to a word boundary and appends ...', () => {
  assert.equal(truncate('the quick brown fox', 13), 'the quick...');
  assert.equal(truncate('short', 100), 'short');
});

test('truncate strictly bounds the result at max even with no word boundary (ellipsis is reserved within max)', () => {
  // Codex stop-time review: the prompt-context per-hit cap relied on
  // `truncate(text, max).length <= max` but the older implementation
  // appended "..." OUTSIDE the budget, so a cap of 50 actually emitted
  // 53 chars. Lock the strict bound with a direct assertion.
  const long = 'x'.repeat(500);
  assert.equal(truncate(long, 50).length, 50);
  assert.equal(truncate(long, 5).length, 5);
  assert.equal(truncate(long, 3), 'xxx'); // not enough room for ellipsis
});

test('cleanSummaryText drops fenced code blocks', () => {
  const input = [
    'Here is a fix.',
    '```ts',
    'const secret = "hidden";',
    '```',
    'Behavior is now correct.',
  ].join('\n');
  const out = cleanSummaryText(input, 500);
  assert.equal(/secret/.test(out), false);
  assert.match(out, /Here is a fix/);
  assert.match(out, /Behavior is now correct/);
});

test('cleanSummaryText drops follow-up prompt lines', () => {
  const input = [
    'I implemented the queue helper.',
    'Want me to wire it into the runtime now?',
    'Also added matching tests.',
  ].join('\n');
  const out = cleanSummaryText(input, 500);
  assert.equal(/Want me to/.test(out), false);
  assert.match(out, /implemented the queue helper/);
  assert.match(out, /matching tests/);
});

test('cleanSummaryText strips markdown emphasis and headings', () => {
  const out = cleanSummaryText('## Plan\n**Bold** and `code` plus __under__.', 500);
  assert.equal(out, 'Plan Bold and code plus under.');
});

test('cleanSummaryText drops bullet markers but keeps content', () => {
  const out = cleanSummaryText('- first thing\n- second thing', 500);
  assert.equal(out, 'first thing second thing');
});

test('cleanCompactSummaryText strips <analysis> blocks and extracts <summary>', () => {
  const input = [
    '<analysis>private chain of thought we MUST drop</analysis>',
    '<summary>The real summary lives here.</summary>',
  ].join('\n');
  const out = cleanCompactSummaryText(input, 500);
  assert.equal(/chain of thought/.test(out), false);
  assert.match(out, /real summary lives here/);
});

test('cleanCompactSummaryText falls back to remaining text when no <summary> present', () => {
  const input = '<analysis>thought</analysis>Plain note after analysis.';
  const out = cleanCompactSummaryText(input, 500);
  assert.equal(/thought/.test(out), false);
  assert.match(out, /Plain note after analysis/);
});

test('cleanCompactSummaryText strips remaining XML-ish tags', () => {
  const out = cleanCompactSummaryText('<note>just this</note>', 500);
  assert.equal(out, 'just this');
});

test('cleanCompactSummaryText drops everything from an unclosed <analysis>', () => {
  // Codex stop-time review: an unclosed analysis block must NEVER
  // persist private reasoning, even when the close tag is missing or
  // malformed. The shell helper truncates from the open tag onward.
  const out = cleanCompactSummaryText(
    'safe prefix line.\n<analysis>private reasoning that leaks',
    500,
  );
  assert.equal(/private reasoning/.test(out), false);
  assert.match(out, /safe prefix line/);
});

test('cleanCompactSummaryText drops a trailing <summary> if the preceding <analysis> is unclosed', () => {
  // If the analysis open is unsealed we cannot trust ANY downstream
  // content — including a later <summary> block — because the model
  // may have spilled reasoning into it. Match the shell's "truncate
  // from <analysis> to EOF" rule.
  const out = cleanCompactSummaryText(
    'lead-in note.\n<analysis>leaky chain of thought\n<summary>untrustworthy</summary>',
    500,
  );
  assert.equal(/leaky chain of thought/.test(out), false);
  assert.equal(/untrustworthy/.test(out), false);
  assert.match(out, /lead-in note/);
});

test('cleanCompactSummaryText drops content from a malformed <analysis tag', () => {
  // Open tag without a closing `>` (truncated) — treat as unclosed
  // and drop everything from the open onward.
  const out = cleanCompactSummaryText(
    'header note.\n<analysis the rest of the buffer is unsafe',
    500,
  );
  assert.equal(/rest of the buffer/.test(out), false);
  assert.match(out, /header note/);
});

test('cleanCompactSummaryText fully strips nested <analysis> blocks', () => {
  // Codex stop-time review: a naive "first close after open" strip
  // pairs the outer open with the inner close, leaking the outer
  // reasoning between the inner close and the outer close. The
  // depth-tracking walker must consume the entire outer block.
  const out = cleanCompactSummaryText(
    'pre.\n<analysis>outer secret <analysis>inner secret</analysis> outer tail</analysis>\nsafe.',
    500,
  );
  assert.equal(/outer secret/.test(out), false);
  assert.equal(/inner secret/.test(out), false);
  assert.equal(/outer tail/.test(out), false);
  assert.match(out, /pre/);
  assert.match(out, /safe/);
});

test('cleanCompactSummaryText drops sibling <analysis> blocks but keeps text between them', () => {
  const out = cleanCompactSummaryText(
    '<analysis>first secret</analysis>middle text<analysis>second secret</analysis>',
    500,
  );
  assert.equal(/first secret/.test(out), false);
  assert.equal(/second secret/.test(out), false);
  assert.match(out, /middle text/);
});

// ---------------------------------------------------------------------------
// Expanded secret redaction corpus (codex production-audit finding 4).
// One assertion per token family so the regex set stays auditable.
// ---------------------------------------------------------------------------

test('redactSecrets masks GitHub ghp_ / gho_ / ghu_ / ghs_ / ghr_ tokens', () => {
  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
    const token = `${prefix}AAAAAAAAAAAAAAAAAAAAAAAA`;
    const out = redactSecrets(`token=${token} continues`);
    assert.match(out, /gh_\[redacted\]/);
    assert.equal(out.includes(token), false, `unredacted: ${prefix}`);
  }
});

test('redactSecrets masks Slack xoxb- / xoxp- / xoxo- / xoxa- tokens', () => {
  for (const prefix of ['xoxb-', 'xoxp-', 'xoxo-', 'xoxa-']) {
    const token = `${prefix}1234567890-1234567890-AbCdEfGhIjKlMnOpQrStUvWx`;
    const out = redactSecrets(`slack ${token} ok`);
    assert.match(out, /xox\[redacted\]/);
    assert.equal(out.includes(token), false, `unredacted: ${prefix}`);
  }
});

test('redactSecrets masks Stripe sk_live_ and sk_test_ keys', () => {
  for (const prefix of ['sk_live_', 'sk_test_']) {
    const token = `${prefix}AbCdEfGh01234567ZZZZZZZZ`;
    const out = redactSecrets(`stripe ${token} ok`);
    assert.match(out, /sk_\[redacted\]/);
    assert.equal(out.includes(token), false, `unredacted: ${prefix}`);
  }
});

test('redactSecrets masks JWT-shaped three-part tokens', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const out = redactSecrets(`auth ${jwt} ok`);
  assert.match(out, /jwt-\[redacted\]/);
  assert.equal(out.includes(jwt), false);
});

test('redactSecrets masks Google ya29 OAuth access tokens', () => {
  const token = 'ya29.A0ARrdaM-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const out = redactSecrets(`auth ${token} ok`);
  assert.match(out, /ya29\.\[redacted\]/);
  assert.equal(out.includes(token), false);
});

// ---------------------------------------------------------------------------
// stripUnsafeModelBlocks generalization (codex production-audit finding 3).
// The walker must handle <thinking> and <scratchpad> with the same
// nesting / fail-closed guarantees as <analysis>.
// ---------------------------------------------------------------------------

test('stripUnsafeModelBlocks removes <thinking> and <scratchpad> blocks', () => {
  const input =
    'safe lead.<thinking>chain of thought</thinking><scratchpad>side notes</scratchpad>safe tail.';
  const out = stripUnsafeModelBlocks(input);
  assert.equal(/chain of thought/.test(out), false);
  assert.equal(/side notes/.test(out), false);
  assert.match(out, /safe lead/);
  assert.match(out, /safe tail/);
});

test('stripUnsafeModelBlocks fails closed on an unclosed <thinking>', () => {
  const out = stripUnsafeModelBlocks('safe.<thinking>private reasoning that leaks');
  assert.equal(/private reasoning/.test(out), false);
  assert.match(out, /safe/);
});

test('stripUnsafeModelBlocks: overlapping <analysis>/<thinking> closes fail closed (no leak, no dangling)', () => {
  // Codex stop-time review: a union-DEPTH counter would have allowed
  // any unsafe close to pop the open span, leaking post-mismatch
  // content as if it had been "after" the unsafe block. Tag-identity
  // matching catches the structural corruption (the FIRST `</analysis>`
  // here closes while the inner `<thinking>` is still on top of the
  // stack) and drops everything from the outer unsafe open onward.
  const input =
    'safe <analysis>secret <thinking>inner</analysis> tail</thinking> after';
  const out = cleanSummaryText(input, 1000);
  for (const banned of ['secret', 'inner', 'tail', '</thinking>', '</analysis>', 'after']) {
    assert.equal(out.includes(banned), false, `banned substring leaked: ${banned}`);
  }
  // Safe lead-in BEFORE the first unsafe open is preserved — that's
  // structurally separable from the corrupted unsafe span.
  assert.match(out, /safe/);
});

test('stripUnsafeModelBlocks: cross-tag overlap in the other order also fails closed', () => {
  const input =
    '<thinking>secret <analysis>inner</thinking> tail</analysis> after';
  const out = cleanSummaryText(input, 1000);
  for (const banned of ['secret', 'inner', 'tail', '</analysis>', '</thinking>', 'after']) {
    assert.equal(out.includes(banned), false, `banned substring leaked: ${banned}`);
  }
});

test('stripUnsafeModelBlocks: a stray mismatched close drops everything past the open', () => {
  // Even a single-level mismatch fails closed: an `<analysis>` opened
  // and then "closed" with `</thinking>` is a corruption signal — we
  // cannot trust that the model actually exited the analysis span,
  // so post-mismatch text MUST NOT survive. (This is the exact codex
  // stop-time finding: depth-only counters leaked here.)
  const out = cleanSummaryText(
    'lead.<analysis>private reasoning</thinking>after-content-that-must-drop',
    1000,
  );
  assert.equal(/private reasoning/.test(out), false);
  assert.equal(/after-content-that-must-drop/.test(out), false);
  assert.equal(/<\/thinking>/.test(out), false);
  assert.match(out, /lead/);
});

test('cleanSummaryText (used by stop) strips <thinking> from assistant content', () => {
  // Stop hook regression: assistant responses can contain <thinking>
  // tags too. The shared stripper must run for stop, not just compact.
  const out = cleanSummaryText(
    'Reviewed the code change.<thinking>I am unsure if my fix is correct</thinking> Confirmed the gates pass.',
    500,
  );
  assert.equal(/I am unsure/.test(out), false);
  assert.match(out, /Reviewed the code change/);
  assert.match(out, /Confirmed the gates pass/);
});

// ---------------------------------------------------------------------------
// sanitizePromptContext (codex production-audit finding 1). Highest-risk
// hook path: retrieved memories flow back into the next agent turn.
// ---------------------------------------------------------------------------

test('sanitizePromptContext redacts secrets per hit', () => {
  const out = sanitizePromptContext(
    ['memory one with sk-AAAAAAAAAAAAAAAA1234 inside', 'memory two clean'],
    { perHitMax: 200, totalMax: 1000 },
  );
  assert.equal(out.lines.length, 2);
  assert.equal(/sk-AAAAAAAAAAAAAAAA1234/.test(out.lines.join('\n')), false);
  assert.match(out.lines[0]!, /sk-\[redacted\]/);
});

test('sanitizePromptContext strictly caps each hit at perHitMax including ellipsis', () => {
  // Strict bound: the result must be <= perHitMax (not perHitMax + 3).
  // Operator-sized prompt-context windows depend on this guarantee.
  const long = 'x'.repeat(500);
  const out = sanitizePromptContext([long], { perHitMax: 50, totalMax: 1000 });
  assert.equal(out.lines[0]!.length, 50);
  assert.match(out.lines[0]!, /\.\.\.$/);
  assert.equal(out.truncated, true);
});

test('sanitizePromptContext stops adding hits once totalMax is exhausted', () => {
  const hit = 'x'.repeat(300);
  const out = sanitizePromptContext([hit, hit, hit, hit], {
    perHitMax: 400,
    totalMax: 700,
  });
  // 300 + 300 = 600. Third hit (300) would overflow (would land at 900);
  // remaining budget at that point is 100, so the third hit gets capped
  // to 100 chars. The fourth hit is dropped entirely.
  assert.equal(out.lines.length, 3);
  assert.equal(out.totalChars <= 700, true, `got ${out.totalChars}`);
  assert.equal(out.truncated, true);
});

test('sanitizePromptContext preserves input order', () => {
  const out = sanitizePromptContext(['alpha', 'beta', 'gamma'], {
    perHitMax: 200,
    totalMax: 1000,
  });
  assert.deepEqual(out.lines, ['alpha', 'beta', 'gamma']);
});

test('sanitizePromptContext drops empty / whitespace-only entries', () => {
  const out = sanitizePromptContext(['', '   ', 'real content'], {
    perHitMax: 200,
    totalMax: 1000,
  });
  assert.deepEqual(out.lines, ['real content']);
});

test('sanitizePromptContext flattens CR/LF/tabs/control chars to single spaces (no bullet escape)', () => {
  // A multi-line memory must not become two bullets in the rendered
  // additionalContext — a poisoned hit that started a new line could
  // inject a fake "- override prior instructions" item.
  const noisy = [
    'first line',
    '## injected heading',
    '- fake bullet attempting to override',
    '\tindented\twith\ttabs',
    'trailing.',
  ].join('\n') + '\rcarriage return tail\x07bell\x00null';
  const out = sanitizePromptContext([noisy], {
    perHitMax: 500,
    totalMax: 5000,
  });
  assert.equal(out.lines.length, 1);
  const flat = out.lines[0]!;
  // No newline / CR / tab / bell / null survives.
  for (const banned of ['\n', '\r', '\t', '\x07', '\x00']) {
    assert.equal(flat.includes(banned), false, `banned char survived: ${JSON.stringify(banned)}`);
  }
  // No double-spaces (whitespace runs were collapsed).
  assert.equal(/\s{2,}/.test(flat), false);
  // Substantive text from each original line is preserved.
  assert.match(flat, /first line/);
  assert.match(flat, /trailing\./);
  assert.match(flat, /carriage return tail/);
});

test('sanitizePromptContext strips <analysis> / <thinking> / <scratchpad> blocks per hit', () => {
  const out = sanitizePromptContext(
    [
      'Lead text.<analysis>chain of thought</analysis> trailing text.',
      'Another hit.<thinking>private musing</thinking> tail.',
      'Third.<scratchpad>side notes</scratchpad> end.',
    ],
    { perHitMax: 1000, totalMax: 5000 },
  );
  assert.equal(out.lines.length, 3);
  for (const banned of ['chain of thought', 'private musing', 'side notes']) {
    assert.equal(
      out.lines.join('\n').includes(banned),
      false,
      `banned substring leaked: ${banned}`,
    );
  }
  assert.match(out.lines[0]!, /Lead text/);
  assert.match(out.lines[1]!, /Another hit/);
  assert.match(out.lines[2]!, /Third/);
});

test('sanitizePromptContext strict per-hit cap holds AFTER normalization (ellipsis within max)', () => {
  // Construct a hit whose post-normalization length is well above the
  // cap; the strict cap must include the ellipsis within `perHitMax`,
  // not append it past the budget. The cap is an UPPER BOUND — word-
  // boundary trimming may yield a shorter result, but never longer.
  const longWords = Array.from({ length: 200 }, (_, i) => `word${i}`).join('\n');
  const out = sanitizePromptContext([longWords], {
    perHitMax: 50,
    totalMax: 5000,
  });
  assert.equal(out.lines[0]!.length <= 50, true, `got ${out.lines[0]!.length}: ${out.lines[0]}`);
  assert.match(out.lines[0]!, /\.\.\.$/);
  assert.equal(out.truncated, true);
  // No newline survived even though the source was newline-separated.
  assert.equal(out.lines[0]!.includes('\n'), false);
});

test('sanitizePromptContext strict per-hit cap exact-fits when no word boundary forces an earlier trim', () => {
  // No-spaces source means word-boundary trim doesn't fire, so the
  // result lands exactly at perHitMax (= max-3 chars + "..."). This
  // is the boundary case that proves the strict-cap-with-ellipsis
  // arithmetic, complementing the upper-bound assertion above.
  const noSpaces = 'x'.repeat(500);
  const out = sanitizePromptContext([noSpaces], {
    perHitMax: 50,
    totalMax: 5000,
  });
  assert.equal(out.lines[0]!.length, 50);
  assert.match(out.lines[0]!, /\.\.\.$/);
});
