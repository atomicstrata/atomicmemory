/**
 * @file Renderer-purity AST scan — fails the build if any module outside
 * `src/renderers/*` writes to stdout/stderr. Per v5 the renderer boundary
 * is non-negotiable: command handlers, adapters, config, lifecycle, and
 * spec code all return data and let renderers own the bytes.
 *
 * Each entry in `LEGACY_ALLOWLIST` is a pre-v5 V0 file that still violates
 * the rule. Remove the entry as part of the PR that ports the file. New
 * files must NOT be added here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..', '..');
const srcRoot = join(cliRoot, 'src');

/**
 * Phase 5 emptied this allowlist. commands.ts and output.ts were
 * deleted in favor of src/commands/* + src/output/* + src/renderers/*;
 * bin.ts was rewritten to write only through the renderer dispatch;
 * help.ts is now a pure string-returning renderer; the V0
 * interactive.tsx was replaced by src/renderers/ink/{index.ts,tui.tsx}
 * which sits under the excluded src/renderers/* prefix. New files
 * MUST NOT be added here.
 */
const LEGACY_ALLOWLIST = new Set<string>([]);

const VIOLATION_PATTERNS = [
  /\bconsole\.(log|error|warn|info|debug|trace)\b/,
  /\bprocess\.stdout\.write\b/,
  /\bprocess\.stderr\.write\b/,
];

test('renderer purity: only src/renderers/* writes to stdout/stderr', () => {
  const offenders: Array<{ file: string; matches: string[] }> = [];

  for (const file of walkSourceFiles(srcRoot)) {
    const rel = relative(srcRoot, file).replaceAll(sep, '/');

    if (rel.startsWith('renderers/')) continue;
    if (rel.startsWith('__tests__/')) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
    if (LEGACY_ALLOWLIST.has(rel)) continue;

    const text = readFileSync(file, 'utf8');
    const stripped = stripCommentsAndStrings(text);
    const matches: string[] = [];
    for (const pattern of VIOLATION_PATTERNS) {
      const m = stripped.match(pattern);
      if (m) matches.push(m[0]);
    }
    if (matches.length > 0) {
      offenders.push({ file: rel, matches });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `non-renderer modules wrote to stdout/stderr:\n${offenders
      .map((o) => `  ${o.file}: ${o.matches.join(', ')}`)
      .join('\n')}`,
  );
});

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (
      s.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.tsx'))
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Crude line+block comment + string-literal stripper sufficient for AST-free regex scans. */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
