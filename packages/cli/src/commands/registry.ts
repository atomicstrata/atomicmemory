/**
 * @file Spec-command-name → handler dispatch. Phase 5 commands all live
 * in this single map so the lifecycle resolver stays trivial.
 *
 * Hidden experimental surfaces (lifecycle/audit/lessons/agents) ARE
 * registered here; the gate inside each handler enforces --experimental
 * and the matching customExtensions capability. `runtime` is NOT
 * registered (no v5 spec entry, no SDK extension).
 */

import { CliError } from '../types.js';
import type { CommandHandler } from './types.js';
import { add } from './memory/add.js';
import { ingest } from './memory/ingest.js';
import { search } from './memory/search.js';
import { packageCommand } from './memory/package.js';
import { list } from './memory/list.js';
import { get } from './memory/get.js';
import { deleteCommand } from './memory/delete.js';
import { importCommand } from './memory/import.js';
import { init } from './setup/init.js';
import { doctor } from './setup/doctor/index.js';
import { status } from './setup/status.js';
import { version } from './setup/version.js';
import { skill } from './setup/skill.js';
import { hooks } from './setup/hooks/index.js';
import { validate } from './setup/validate.js';
import { completion } from './setup/completion.js';
import { help } from './setup/help.js';
import { show } from './config/show.js';
import { configGet } from './config/get.js';
import { set as configSet } from './config/set.js';
import { unset as configUnset } from './config/unset.js';
import {
  profileList,
  profileShow,
  profileUse,
} from './config/profile.js';
import { lifecycle } from './_experimental/lifecycle.js';
import { audit } from './_experimental/audit.js';
import { lessons } from './_experimental/lessons.js';
import { agents } from './_experimental/agents.js';

const HANDLERS: Record<string, CommandHandler> = {
  // setup
  init,
  doctor,
  status,
  version,
  // bare `skill` (no subcommand) and the three nested children all
  // route through the same handler; it dispatches on ctx.command.
  skill,
  'skill list': skill,
  'skill get': skill,
  'skill path': skill,
  hooks,
  validate,
  completion,
  help,
  // memory
  add,
  ingest,
  search,
  package: packageCommand,
  list,
  get,
  delete: deleteCommand,
  import: importCommand,
  // config
  'config show': show,
  'config get': configGet,
  'config set': configSet,
  'config unset': configUnset,
  'config profile list': profileList,
  'config profile use': profileUse,
  'config profile show': profileShow,
  // experimental
  lifecycle,
  audit,
  lessons,
  agents,
};

export function resolveHandler(commandPath: string): CommandHandler {
  const handler = HANDLERS[commandPath];
  if (!handler) {
    throw new CliError('usage', `unknown command: "${commandPath}"`);
  }
  return handler;
}

export function knownCommands(): string[] {
  return Object.keys(HANDLERS).sort();
}
