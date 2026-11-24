/** Prove the documentation checker compiles real package imports and rejects incorrect scope types. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function checkScope(user: string): SpawnSyncReturns<string> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temporary = mkdtempSync(join(root, '.docs-check-test-'));
  try {
    const file = join(temporary, 'guide.md');
    writeFileSync(file, `\`\`\`ts\nimport { MemoryClient } from '@atomicmemory/sdk';
import { memoryTools } from '@atomicmemory/vercel-ai-sdk/tools';
const client = new MemoryClient({ providers: { atomicmemory: { apiUrl: 'https://example.com' } } });
const tools = memoryTools({ client, scope: { user: ${user} } });
\`\`\`\n`);
    return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-doc-examples.mjs', import.meta.url)), file], {
      encoding: 'utf8',
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('documentation checker accepts real tools and rejects a numeric user', () => {
  const valid = checkScope("'docs-demo-user'");
  assert.equal(valid.status, 0, String(valid.stdout) + String(valid.stderr));
  assert.match(String(valid.stdout), /Documentation examples compile against the workspace packages\./);
  const invalid = checkScope('123');
  assert.equal(invalid.status, 2);
  assert.match(String(invalid.stdout), /Type 'number' is not assignable to type 'string'/);
});
