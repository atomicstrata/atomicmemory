/**
 * @file Interactive dashboard command runner. It reuses the prepared
 * runtime profile/scope for ordinary prompt submissions, refreshes the
 * cache after config mutations, and blocks stdin/output flags that do
 * not make sense while Ink owns the terminal.
 */

import { CliError, type CommandResult, type OutputMode } from '../types.js';
import { resolveHandler } from '../commands/registry.js';
import type { CommandContext, CommandFlags } from '../commands/types.js';
import {
  defaultModeFor,
  enforceAllowedOutputs,
  rejectInvalidOutputFlag,
  rejectStdinFlagCombo,
} from './output-policy.js';
import { parseInvocation, type Invocation } from './parse-invocation.js';
import { splitShellWords } from './shell-words.js';
import type { StdinReader } from './stdin-reader.js';
import type { RuntimeState } from './runtime.js';

interface InteractiveRuntimeSessionInputs {
  baseState: RuntimeState;
  buildRuntimeContext: (inputs: {
    state: RuntimeState;
    invocation: Invocation;
    env: NodeJS.ProcessEnv;
    version: string;
    stdin: StdinReader;
  }) => CommandContext;
  createInitialState: () => RuntimeState;
  enforceRuntimeGates: (invocation: Invocation, scope: RuntimeState['scope']) => void;
  parentInvocation: Invocation;
  prepareRuntimeState: (
    state: RuntimeState,
    invocation: Invocation,
    env: NodeJS.ProcessEnv,
    stdin: StdinReader,
  ) => Promise<void>;
  version: string;
}

interface ParsedInteractiveCommand {
  commandFlags: CommandFlags;
  invocation: Invocation;
}

const INHERITED_INTERACTIVE_FLAGS = [
  'api-url',
  'config',
  'experimental',
  'profile',
  'provider',
  'trust-surface',
  'user',
  'agent-id',
  'namespace',
  'thread',
] as const;

const STATE_OVERRIDE_FLAGS = new Set<string>(INHERITED_INTERACTIVE_FLAGS);
const OUTPUT_SHAPING_FLAGS = ['agent', 'json', 'output'] as const;
const CACHE_INVALIDATING_COMMANDS = new Set([
  'init',
  'config set',
  'config unset',
  'config profile use',
]);

const NOOP_STDIN_READER: StdinReader = {
  async read() {
    return '';
  },
};

export function createInteractiveRuntimeSession(inputs: InteractiveRuntimeSessionInputs): (line: string) => Promise<CommandResult<unknown>> {
  let cachedState = cloneRuntimeState(inputs.baseState);

  return async (line: string) => {
    const parsed = await parseInteractiveCommand(line, inputs.parentInvocation.flags);
    rejectInteractiveOutputFlags(parsed.commandFlags);
    rejectInteractiveStdinUse(parsed.invocation);

    const env = process.env;
    const reuseCachedState = !hasInteractiveStateOverride(parsed.commandFlags) &&
      !CACHE_INVALIDATING_COMMANDS.has(parsed.invocation.path);
    const state = reuseCachedState ? cloneRuntimeState(cachedState) : inputs.createInitialState();

    if (reuseCachedState) prepareCachedRuntimeState(inputs, state, parsed.invocation);
    else await inputs.prepareRuntimeState(state, parsed.invocation, env, NOOP_STDIN_READER);

    const ctx = inputs.buildRuntimeContext({
      state,
      invocation: parsed.invocation,
      env,
      version: inputs.version,
      stdin: NOOP_STDIN_READER,
    });
    const result = await resolveHandler(parsed.invocation.path)(ctx);

    if (CACHE_INVALIDATING_COMMANDS.has(parsed.invocation.path)) {
      cachedState = await refreshCachedState(inputs, env);
    }
    return result;
  };
}

export function mergeInteractiveFlags(
  parentFlags: CommandFlags,
  commandFlags: CommandFlags,
): CommandFlags {
  return {
    ...inheritedInteractiveFlags(parentFlags),
    ...commandFlags,
    interactive: false,
  };
}

function prepareCachedRuntimeState(
  inputs: InteractiveRuntimeSessionInputs,
  state: RuntimeState,
  invocation: Invocation,
): void {
  rejectInvalidOutputFlag(invocation.flags);
  rejectStdinFlagCombo(invocation.flags);
  state.mode = resolveInteractiveCommandMode(invocation);
  enforceAllowedOutputs(invocation.path, state.mode);
  inputs.enforceRuntimeGates(invocation, state.scope);
}

async function parseInteractiveCommand(
  line: string,
  parentFlags: CommandFlags,
): Promise<ParsedInteractiveCommand> {
  const parsed = await parseInvocation(splitShellWords(line));
  if (parsed.error) throw parsed.error;
  if (!parsed.invocation) {
    throw new CliError('usage', 'no command matched the interactive input');
  }

  return {
    commandFlags: parsed.invocation.flags,
    invocation: {
      ...parsed.invocation,
      flags: mergeInteractiveFlags(parentFlags, parsed.invocation.flags),
    },
  };
}

function inheritedInteractiveFlags(parentFlags: CommandFlags): CommandFlags {
  const inherited: CommandFlags = {};
  for (const name of INHERITED_INTERACTIVE_FLAGS) {
    if (parentFlags[name] !== undefined) inherited[name] = parentFlags[name];
  }
  return inherited;
}

function rejectInteractiveOutputFlags(flags: CommandFlags): void {
  for (const name of OUTPUT_SHAPING_FLAGS) {
    if (flags[name] !== undefined && flags[name] !== false) {
      throw new CliError(
        'usage',
        'dashboard commands render inside the session; remove --json, --agent, or --output',
      );
    }
  }
}

function rejectInteractiveStdinUse(invocation: Invocation): void {
  const flags = invocation.flags;
  if (
    flags.stdin === true ||
    flags['api-key-stdin'] === true ||
    flags.file === '-' ||
    (invocation.path === 'import' && invocation.positional[0] === '-')
  ) {
    throw new CliError(
      'usage',
      `command "${invocation.path}" cannot read stdin inside the interactive dashboard; run it outside interactive mode`,
    );
  }
}

function hasInteractiveStateOverride(flags: CommandFlags): boolean {
  return Object.keys(flags).some((name) => STATE_OVERRIDE_FLAGS.has(name));
}

function resolveInteractiveCommandMode(invocation: Invocation): OutputMode {
  return resolveOutputModeForInteractive({
    agentFlag: invocation.flags.agent === true,
    jsonFlag: invocation.flags.json === true,
    ...(typeof invocation.flags.output === 'string'
      ? { outputFlag: invocation.flags.output as OutputMode }
      : {}),
    commandDefault: defaultModeFor(invocation.path),
  });
}

function resolveOutputModeForInteractive(inputs: {
  agentFlag: boolean;
  jsonFlag: boolean;
  outputFlag?: OutputMode;
  commandDefault: OutputMode;
}): OutputMode {
  if (inputs.agentFlag) return 'agent';
  if (inputs.jsonFlag) return 'json';
  if (inputs.outputFlag) return inputs.outputFlag;
  return inputs.commandDefault;
}

async function refreshCachedState(
  inputs: InteractiveRuntimeSessionInputs,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeState> {
  const state = inputs.createInitialState();
  const invocation: Invocation = {
    ...inputs.parentInvocation,
    flags: mergeInteractiveFlags(inputs.parentInvocation.flags, {}),
  };
  await inputs.prepareRuntimeState(state, invocation, env, NOOP_STDIN_READER);
  return cloneRuntimeState(state);
}

function cloneRuntimeState(state: RuntimeState): RuntimeState {
  return {
    ...state,
    paths: { ...state.paths },
    scope: { ...state.scope },
    profile: state.profile
      ? {
        ...state.profile,
        ...(state.profile.scope ? { scope: { ...state.profile.scope } } : {}),
      }
      : null,
  };
}
