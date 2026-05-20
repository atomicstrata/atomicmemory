/**
 * Live integration smoke for the Codex account-auth LLM provider.
 *
 * This test is default-on for developer machines where `codex login` has
 * created a ChatGPT auth file. Set ATOMICMEMORY_SKIP_CODEX_TEST=1 to opt out
 * when avoiding local account usage.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexLLM } from '../codex-llm.js';
import { DEFAULT_CODEX_LLM_MODEL } from '../llm-defaults.js';

const SKIP_ENV = 'ATOMICMEMORY_SKIP_CODEX_TEST';

interface CodexReadiness {
  runnable: boolean;
  authPath: string;
  reason: string;
}

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
  };
}

const readiness = await resolveCodexReadiness();

describe.skipIf(!readiness.runnable)(`CodexLLM live integration (${readiness.reason})`, () => {
  it('runs through Codex local auth without OPENAI_API_KEY', async () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const provider = new CodexLLM({
        llmProvider: 'codex',
        llmModel: DEFAULT_CODEX_LLM_MODEL,
        llmApiUrl: undefined,
        codexAuthPath: readiness.authPath,
        costLoggingEnabled: false,
        costRunId: 'codex-live-test',
        costLogDir: '/tmp/atomicmemory-codex-live-test',
      });

      const output = await provider.chat([
        { role: 'system', content: 'Return exactly: atomicmemory-codex-ok' },
        { role: 'user', content: 'Run the AtomicMemory Codex live smoke test.' },
      ]);

      expect(output).toContain('atomicmemory-codex-ok');
    } finally {
      restoreEnv('OPENAI_API_KEY', previousOpenAiApiKey);
    }
  }, 120_000);
});

async function resolveCodexReadiness(): Promise<CodexReadiness> {
  const authPath = process.env.CODEX_AUTH_PATH ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  if (process.env[SKIP_ENV] === '1') {
    return { runnable: false, authPath, reason: `${SKIP_ENV}=1` };
  }

  try {
    const parsed = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthFile;
    if (parsed.auth_mode !== 'chatgpt') {
      return { runnable: false, authPath, reason: `codex auth at ${authPath} is not ChatGPT login auth` };
    }
    if (!parsed.tokens?.access_token) {
      return { runnable: false, authPath, reason: `codex auth at ${authPath} has no access token` };
    }
    return { runnable: true, authPath, reason: `codex auth file is present at ${authPath}` };
  } catch (error) {
    return { runnable: false, authPath, reason: `codex auth unavailable: ${errorMessage(error)}` };
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
