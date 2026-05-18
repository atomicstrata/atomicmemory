/**
 * @file `atomicmemory completion bash|zsh` — generate completion script
 * from cli-spec. Hidden experimental commands are excluded from
 * generated completions per v5.
 *
 * The result `data` is the raw script as a string so the text
 * renderer prints it verbatim — `eval "$(atomicmemory completion
 * bash)"` and `source <(atomicmemory completion zsh)` are the
 * canonical install patterns and require no JSON wrapper. The spec
 * declares `allowed_outputs: ["text"]` so machine modes never reach
 * this handler.
 */

import { CliError } from '../../types.js';
import { generateCompletion } from '../../spec/completions.js';
import { loadSpec } from '../../spec/loader.js';
import type { CommandHandler } from '../types.js';

export const completion: CommandHandler<string> = async (ctx) => {
  const shell = ctx.positional[0];
  if (shell !== 'bash' && shell !== 'zsh') {
    throw new CliError(
      'usage',
      `completion supports bash|zsh in V1; got "${String(shell)}". Fish and PowerShell are V1.1.`,
    );
  }
  const script = generateCompletion(shell, loadSpec());
  return {
    command: 'completion',
    data: script,
    count: 1,
    meta: { shell },
  };
};
