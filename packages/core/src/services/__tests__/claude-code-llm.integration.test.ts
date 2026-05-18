/**
 * Live integration smoke for the Claude Code Agent SDK-backed LLM provider.
 *
 * This test is default-on for developer machines where Claude Code is
 * installed and logged in. Set ATOMICMEMORY_SKIP_CLAUDE_CODE_TEST=1 to opt out
 * when avoiding local subscription usage.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeLLM } from '../claude-code-llm.js';

const execFileAsync = promisify(execFile);
const SKIP_ENV = 'ATOMICMEMORY_SKIP_CLAUDE_CODE_TEST';

interface ClaudeCodeReadiness {
  runnable: boolean;
  reason: string;
}

interface ClaudeAuthStatus {
  loggedIn?: boolean;
}

const readiness = await resolveClaudeCodeReadiness();

describe.skipIf(!readiness.runnable)(`ClaudeCodeLLM live integration (${readiness.reason})`, () => {
  it('runs through Claude Code local auth without ANTHROPIC_API_KEY', async () => {
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const provider = new ClaudeCodeLLM({
        llmProvider: 'claude-code',
        llmModel: '',
        costLoggingEnabled: false,
        costRunId: 'claude-code-live-test',
        costLogDir: '/tmp/atomicmemory-claude-code-live-test',
      });

      const output = await provider.chat([
        { role: 'system', content: 'Return exactly: atomicmemory-claude-code-ok' },
        { role: 'user', content: 'Run the AtomicMemory Claude Code live smoke test.' },
      ]);

      expect(output).toContain('atomicmemory-claude-code-ok');
    } finally {
      restoreEnv('ANTHROPIC_API_KEY', previousAnthropicApiKey);
    }
  }, 60_000);
});

async function resolveClaudeCodeReadiness(): Promise<ClaudeCodeReadiness> {
  if (process.env[SKIP_ENV] === '1') {
    return { runnable: false, reason: `${SKIP_ENV}=1` };
  }

  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status', '--json'], {
      timeout: 10_000,
      maxBuffer: 10_000,
    });
    const status = JSON.parse(stdout) as ClaudeAuthStatus;
    if (status.loggedIn !== true) {
      return { runnable: false, reason: 'claude auth status reports loggedIn=false' };
    }
    return { runnable: true, reason: 'claude auth status reports loggedIn=true' };
  } catch (error) {
    return { runnable: false, reason: `claude auth status unavailable: ${errorMessage(error)}` };
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
