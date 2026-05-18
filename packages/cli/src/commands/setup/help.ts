/**
 * @file `atomicmemory help [command]` — human or `--json` view of the
 * spec, sourced from the shared loader. Hidden experimental commands
 * are excluded from the help-facing document; use `--experimental`
 * to invoke one (it still won't appear in default help).
 */

import { commandSpecDocument, renderHelp } from '../../help.js';
import type { CommandHandler } from '../types.js';

export const help: CommandHandler<unknown> = async (ctx) => {
  const json = ctx.flags.json === true || ctx.flags.agent === true;
  if (json) {
    const doc = commandSpecDocument();
    return {
      command: 'help',
      data: doc,
      count: doc.commands.length,
    };
  }
  const target = ctx.positional.length > 0 ? ctx.positional.join(' ') : undefined;
  const text = renderHelp(target, ctx.version);
  return {
    command: 'help',
    data: text,
    count: 1,
  };
};
