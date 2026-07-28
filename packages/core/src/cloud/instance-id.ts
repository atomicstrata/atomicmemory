/**
 * Stable Core installation id for Cloud runtime identity and trace envelopes.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_STATE_DIR = join(homedir(), '.atomicmemory', 'state');

function resolveInstanceIdPath(): string {
  const stateDir = process.env.CORE_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
  return join(stateDir, 'core-instance-id');
}

export async function resolveCoreInstanceId(configuredId: string): Promise<string> {
  if (configuredId.trim()) return configuredId.trim();
  const instanceIdPath = resolveInstanceIdPath();
  try {
    const existing = await readFile(instanceIdPath, 'utf8');
    const trimmed = existing.trim();
    if (trimmed) return trimmed;
  } catch {
    // first boot — generate below
  }
  const generated = randomUUID();
  await mkdir(dirname(instanceIdPath), { recursive: true });
  await writeFile(instanceIdPath, `${generated}\n`, 'utf8');
  return generated;
}
