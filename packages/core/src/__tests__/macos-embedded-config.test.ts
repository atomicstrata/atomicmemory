/**
 * Static contracts for the macOS embedded runtime and Deno compile path.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

describe('macos embedded runtime contracts', () => {
  it('launcher defaults RUNTIME_ROOT to the script directory and binds loopback', () => {
    const entry = read('scripts/macos-embedded-entrypoint.sh');
    expect(entry).toContain('RUNTIME_ROOT="${RUNTIME_ROOT:-$SCRIPT_DIR}"');
    expect(entry).toContain('LISTEN_HOST="${LISTEN_HOST:-127.0.0.1}"');
    expect(entry).not.toContain('$(cd "$SCRIPT_DIR/.." && pwd)');
  });

  it('embedded Postgres uses SCRAM and refuses unrecognized data dirs', () => {
    const pg = read('scripts/lib/macos-embedded-postgres.sh');
    expect(pg).toContain('--auth-local=scram-sha-256');
    expect(pg).toContain('--auth-host=scram-sha-256');
    expect(pg).toContain('refusing to initialize');
    expect(pg).not.toContain('--auth-local=trust');
    expect(pg).not.toContain('rm -rf "$EMBEDDED_POSTGRES_DATA_DIR"');
  });

  it('compile path is lockfile-faithful and grants write access', () => {
    const compile = read('scripts/deno-compile-core.sh');
    expect(compile).toContain('write-pinned');
    expect(compile).toContain('pnpm list --filter @atomicmemory/core --depth 0 --prod --json');
    expect(compile).toContain('pnpm install --prod --ignore-scripts');
    expect(compile).toContain('--ignore-workspace');
    expect(compile).toContain('--config.node-linker=hoisted');
    expect(compile).toContain('strip_isolated_store');
    expect(compile).toContain('--allow-write');
    expect(compile).not.toContain('pnpm --filter @atomicmemory/core deploy --prod');
    expect(compile).not.toMatch(/^\s*npm install/m);
  });

  it('postgres pack validates pgvector and emits a darwin- archive name', () => {
    const pack = read('scripts/package-darwin-pgvector.sh');
    expect(pack).toContain('atomicmemory-postgres-pgvector-darwin-${ARCH}.tar.gz');
    expect(pack).toContain('vector.control');
    expect(pack).toContain('vector.dylib');
    expect(pack).not.toContain('2>/dev/null || true');
  });
});
