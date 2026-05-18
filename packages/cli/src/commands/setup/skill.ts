/**
 * @file `atomicmemory skill list|get|path` — bundled agent
 * instructions. Adapter-free.
 *
 * Phase 5 audit-3 fix: each subcommand has its own spec args, so
 * `skill get <name>` captures the name as positional[0]. The handler
 * dispatches on `ctx.command` ("skill list", "skill get", "skill path",
 * or bare "skill"). All three child paths route to this single
 * handler via the registry; the bare "skill" path defaults to
 * listing.
 */

import { CliError } from '../../types.js';
import {
  getSkill,
  getSkillPath,
  listSkills,
} from '../../skills.js';
import type { CommandHandler } from '../types.js';

export const skill: CommandHandler<unknown> = async (ctx) => {
  const action = parseAction(ctx.command);
  switch (action) {
    case 'list':
      return {
        command: 'skill list',
        data: { skills: listSkills() },
        count: listSkills().length,
      };
    case 'get': {
      const name = ctx.positional[0];
      if (!name) throw new CliError('missing_input', 'skill get requires a name');
      const sk = getSkill(name);
      return {
        command: 'skill get',
        data: { name, content: sk.content },
        count: 1,
      };
    }
    case 'path': {
      const name = ctx.positional[0];
      if (!name) throw new CliError('missing_input', 'skill path requires a name');
      return {
        command: 'skill path',
        data: { name, path: getSkillPath(name) },
        count: 1,
      };
    }
  }
};

function parseAction(command: string): 'list' | 'get' | 'path' {
  // ctx.command is "skill", "skill list", "skill get", or "skill path".
  // Bare "skill" defaults to list.
  const segments = command.split(/\s+/);
  const tail = segments[1];
  if (tail === 'list' || tail === 'get' || tail === 'path') return tail;
  return 'list';
}
