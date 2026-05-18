/**
 * @file SDK-import containment AST scan — fails the build if any module
 * outside `src/adapters/*` imports from `@atomicmemory/sdk`
 * (including subpaths like `/browser`, `/memory`, `/storage`). Per v5 the
 * adapter boundary is non-negotiable: command handlers and renderers must
 * never see SDK shapes directly.
 *
 * V0 currently violates this from `commands.ts` and `client.ts`. Those
 * entries leave the allowlist when their files are ported in Phase 4/5.
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
 * Phase 5 emptied this allowlist: commands.ts/client.ts/output.ts were
 * deleted in favor of src/commands/* + src/adapters/* + src/output/* +
 * src/renderers/*. The only modules that may import from
 * @atomicmemory/sdk* are now under src/adapters/*. New
 * files MUST NOT be added here.
 */
const LEGACY_ALLOWLIST = new Set<string>([]);

const SDK_IMPORT_PATTERN =
  /(?:from|import)\s*\(?["']@atomicmemory\/sdk(?:[/'"]|$)/;

test('SDK import containment: only src/adapters/* imports @atomicmemory/sdk*', () => {
  const offenders: Array<{ file: string; line: string }> = [];

  for (const file of walkSourceFiles(srcRoot)) {
    const rel = relative(srcRoot, file).replaceAll(sep, '/');

    if (rel.startsWith('adapters/')) continue;
    if (rel.startsWith('__tests__/')) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
    if (LEGACY_ALLOWLIST.has(rel)) continue;

    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (
        (trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')) &&
        SDK_IMPORT_PATTERN.test(trimmed)
      ) {
        continue;
      }
      if (SDK_IMPORT_PATTERN.test(line)) {
        offenders.push({ file: rel, line: trimmed });
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `non-adapter modules imported from @atomicmemory/sdk:\n${offenders
      .map((o) => `  ${o.file}: ${o.line}`)
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
