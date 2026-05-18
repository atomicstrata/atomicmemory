#!/usr/bin/env node
/**
 * @file v5 CLI entrypoint. Thin shell that wires:
 *   1. rejectPlainApiKeyFlag(argv)               — secrets-in-history guard
 *   2. parseInvocation(argv)                     — commander built from cli-spec.json
 *   3. runInvocation(invocation, startTime)      — lifecycle + render
 *
 * The lifecycle (cli/runtime.ts) resolves config + named profile +
 * scope (flags > env > profile.scope), constructs the provider
 * adapter lazily on demand, dispatches to the spec-bound handler,
 * and routes the typed result through the v5 renderer (plain text or
 * the V1 Ink TUI).
 *
 * Side-effect import registers every V1 command's agent sanitizer so
 * the renderers/agent.ts pipeline can encode envelopes without
 * throwing.
 */

import { rejectPlainApiKeyFlag } from './config/api-key.js';
import { parseInvocation } from './cli/parse-invocation.js';
import { runInvocation } from './cli/runtime.js';
import { renderTopLevelError } from './cli/error-render.js';
import type { ExitCode } from './types.js';

export const CLI_VERSION = '0.1.2';

async function main(argv: string[]): Promise<ExitCode> {
  const startTime = Date.now();

  try {
    rejectPlainApiKeyFlag(argv);
  } catch (err) {
    return renderTopLevelError(err, 'unknown', startTime, argv);
  }

  const parsed = await parseInvocation(argv);
  if (parsed.error) {
    return renderTopLevelError(parsed.error, 'unknown', startTime, argv);
  }

  return runInvocation(
    parsed.invocation ?? { path: 'help', positional: [], flags: {} },
    startTime,
    CLI_VERSION,
  );
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
