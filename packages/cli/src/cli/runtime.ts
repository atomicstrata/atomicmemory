/**
 * @file Lifecycle runner. Builds a CommandContext from a parsed
 * invocation, dispatches to the spec-bound handler, and renders the
 * typed result via the v5 renderers.
 *
 * Adapter construction is lazy: the context exposes ctx.getAdapter()
 * which dynamic-imports adapters/registry only when a provider
 * command actually reaches for it. This keeps SDK module-load side
 * effects (e.g. transformers-env logger) off the agent/json paths.
 */

// Side-effect import: registers every V1 command's agent sanitizer so
// the renderers/agent.ts pipeline can encode envelopes without
// throwing. Lives here (not bin.ts) so any entry that calls
// runInvocation — the bin, integration tests, programmatic embedders —
// gets the registrations.
import '../output/sanitizers/index.js';
import { resolveApiKey, API_KEY_ENV_VAR } from '../config/api-key.js';
import { loadConfig } from '../config/profiles.js';
import { resolveConfigPaths } from '../config/paths.js';
import { assertStaticScope, resolveScope } from '../config/resolve.js';
import { emptyConfig, type CliConfigShape, type CliProfileShape } from '../config/schema.js';
import { exitCodeFor } from '../output/envelope.js';
import { renderError, renderSuccess, resolveOutputMode } from '../renderers/index.js';
import { resolveHandler } from '../commands/registry.js';
import { applyOverlay, resolveBaseProfile } from './profile-resolution.js';
import { createInteractiveRuntimeSession } from './interactive-session.js';
import {
  defaultModeFor,
  enforceAllowedOutputs,
  inkShouldLaunch,
  rejectInteractiveOnNonText,
  rejectInvalidOutputFlag,
  rejectStdinFlagCombo,
} from './output-policy.js';
import { makeStdinReader, type StdinReader } from './stdin-reader.js';
import { CliError, type ExitCode, type OutputMode, type RenderContext } from '../types.js';
import type { InteractiveDashboardOptions } from '../renderers/ink/dashboard.js';
import type { AdapterHandle, CommandContext, CommandFlags } from '../commands/types.js';
import type { CliScopePartial } from '../types.js';
import type { Invocation } from './parse-invocation.js';

const COMMANDS_REQUIRING_USER = new Set<string>([
  'add', 'ingest', 'search', 'package', 'list', 'get', 'delete',
  'import', 'status', 'lifecycle', 'audit', 'lessons', 'agents',
]);
// `hooks` is intentionally omitted: install is provider-free, and run
// subcommands call requireScope only for event paths that touch memory.

const HIDDEN_EXPERIMENTAL_COMMANDS = new Set<string>(['lifecycle', 'audit', 'lessons', 'agents']);
const PROVIDER_FREE_COMMANDS = new Set<string>([
  'help', 'version', 'completion', 'skill', 'skill list', 'skill get',
  'skill path', 'config show', 'config get', 'config set', 'config unset',
  'config profile list', 'config profile use', 'config profile show',
]);

export interface RuntimeState {
  mode: OutputMode;
  profileName: string;
  scope: CliScopePartial;
  config: CliConfigShape;
  profile: CliProfileShape | null;
  paths: { dir: string; file: string };
}

export async function runInvocation(
  invocation: Invocation,
  startTime: number,
  version: string,
): Promise<ExitCode> {
  const env = process.env;
  const stdin = makeStdinReader();
  const state = createInitialState();
  try {
    await prepareRuntimeState(state, invocation, env, stdin);
    const ctx = buildRuntimeContext({ state, invocation, env, version, stdin });
    const result = await resolveHandler(invocation.path)(ctx);
    await renderRuntimeSuccess({ result, state, invocation, env, startTime, version });
    return 0;
  } catch (err) {
    return renderRuntimeError({ err, state, invocation, env, startTime });
  }
}

function createInitialState(): RuntimeState {
  return {
    mode: 'text',
    profileName: 'default',
    scope: {},
    config: emptyConfig(),
    profile: null,
    paths: { dir: '', file: '' },
  };
}

async function prepareRuntimeState(
  state: RuntimeState,
  invocation: Invocation,
  env: NodeJS.ProcessEnv,
  stdin: StdinReader,
): Promise<void> {
  rejectInvalidOutputFlag(invocation.flags);
  rejectStdinFlagCombo(invocation.flags);
  // Set state.mode as soon as it's known so any subsequent error
  // (including the --interactive gate below) renders in the resolved
  // mode rather than the default "text" placeholder.
  state.mode = resolveOutputMode({
    agentFlag: invocation.flags.agent === true,
    jsonFlag: invocation.flags.json === true,
    ...(typeof invocation.flags.output === 'string'
      ? { outputFlag: invocation.flags.output as OutputMode }
      : {}),
    commandDefault: defaultModeFor(invocation.path),
  });
  enforceAllowedOutputs(invocation.path, state.mode);
  rejectInteractiveOnNonText(invocation.flags, state.mode);
  Object.assign(state, loadRuntimeConfig(invocation, env));
  state.profile = resolveRuntimeProfile(invocation, state.config, state.profileName, env);
  state.scope = resolveRuntimeScope(invocation, state.profile, env);
  enforceRuntimeGates(invocation, state.scope);
  state.profile = await applyApiKeyOverlay(state.profile, invocation, env, stdin);
}

interface RuntimeContextInputs {
  state: RuntimeState;
  invocation: Invocation;
  env: NodeJS.ProcessEnv;
  version: string;
  stdin: StdinReader;
}

function buildRuntimeContext(inputs: RuntimeContextInputs): CommandContext {
  return buildContext({
    invocation: inputs.invocation,
    config: inputs.state.config,
    paths: inputs.state.paths,
    profile: inputs.state.profile,
    scope: inputs.state.scope,
    env: inputs.env,
    version: inputs.version,
    stdin: inputs.stdin,
  });
}

function loadRuntimeConfig(
  invocation: Invocation,
  env: NodeJS.ProcessEnv,
): Pick<RuntimeState, 'paths' | 'config' | 'profileName'> {
  const paths = resolveConfigPaths({
    env,
    ...(typeof invocation.flags.config === 'string'
      ? { flagOverride: invocation.flags.config }
      : {}),
  });
  const persisted = loadConfig(paths.file);
  const config: CliConfigShape =
    Object.keys(persisted.profiles).length > 0 ? persisted : emptyConfig();
  const profileName =
    typeof invocation.flags.profile === 'string'
      ? invocation.flags.profile
      : config.activeProfile;
  return { paths, config, profileName };
}

export function resolveRuntimeProfile(
  invocation: Invocation,
  config: CliConfigShape,
  profileName: string,
  env: NodeJS.ProcessEnv,
): CliProfileShape | null {
  if (invocation.path === 'init') {
    return config.profiles[profileName] ?? null;
  }
  if (isProviderFreeInvocation(invocation) && !isDashboardInvocation(invocation)) {
    return null;
  }
  const baseProfile = resolveBaseProfile(invocation.flags, config, profileName, env);
  return baseProfile ? applyOverlay(baseProfile, invocation.flags) : null;
}

function isProviderFreeInvocation(invocation: Invocation): boolean {
  if (PROVIDER_FREE_COMMANDS.has(invocation.path)) return true;
  return invocation.path === 'hooks' && invocation.positional[0] === 'install';
}

function isDashboardInvocation(invocation: Invocation): boolean {
  return invocation.source === 'bare' || invocation.flags.interactive === true;
}

export function resolveRuntimeScope(
  invocation: Invocation,
  profile: CliProfileShape | null,
  env: NodeJS.ProcessEnv,
): CliScopePartial {
  return resolveScope({
    ...(profile?.scope ? { profileScope: profile.scope } : {}),
    flags: extractScopeFlags(invocation.flags),
    env,
  });
}

function enforceRuntimeGates(invocation: Invocation, scope: CliScopePartial): void {
  // Experimental gate fires BEFORE the static scope check per the
  // v5 plan §"Phase 4 — capability gates": hidden commands must
  // surface `experimental_disabled` first; only when --experimental
  // is passed do we proceed to static scope, adapter init, and
  // capability checks.
  const topLevelCommand = invocation.path.split(' ')[0]!;
  if (
    HIDDEN_EXPERIMENTAL_COMMANDS.has(topLevelCommand) &&
    invocation.flags.experimental !== true
  ) {
    throw new CliError(
      'experimental_disabled',
      `command "${topLevelCommand}" is experimental and requires --experimental to invoke`,
    );
  }
  if (COMMANDS_REQUIRING_USER.has(topLevelCommand)) {
    assertStaticScope(scope, { requireUser: true });
  }
}

async function applyApiKeyOverlay(
  profile: CliProfileShape | null,
  invocation: Invocation,
  env: NodeJS.ProcessEnv,
  stdin: StdinReader,
): Promise<CliProfileShape | null> {
  if (!profile) return null;
  const next: CliProfileShape = { ...profile };
  if (invocation.flags['api-key-stdin'] === true) {
    const piped = (await stdin.read()).trim();
    if (piped.length > 0) next.apiKey = piped;
  }
  const envKey = env[API_KEY_ENV_VAR];
  const resolvedKey = resolveApiKey({
    ...(typeof envKey === 'string' && envKey.length > 0 ? { envApiKey: envKey } : {}),
    ...(typeof next.apiKey === 'string' && next.apiKey.length > 0
      ? { profileApiKey: next.apiKey }
      : {}),
  });
  if (resolvedKey) next.apiKey = resolvedKey;
  return next;
}

interface RenderSuccessInputs {
  result: Awaited<ReturnType<ReturnType<typeof resolveHandler>>>;
  state: RuntimeState;
  invocation: Invocation;
  env: NodeJS.ProcessEnv;
  startTime: number;
  version: string;
}

async function renderRuntimeSuccess(inputs: RenderSuccessInputs): Promise<void> {
  const renderCtx = buildSuccessRenderContext(inputs);
  if (renderCtx.interactive) {
    await renderInteractiveSuccess({ ...inputs, renderCtx });
    return;
  }
  renderSuccess(renderCtx, inputs.result);
}

function buildSuccessRenderContext(inputs: RenderSuccessInputs): RenderContext {
  const { result, state, invocation, env, startTime } = inputs;
  return {
    mode: state.mode,
    interactive: inkShouldLaunch(invocation.flags, state.mode, env),
    profileName: state.config.activeProfile || state.profileName,
    ...(Object.keys(state.scope).length > 0 ? { scope: state.scope } : {}),
    startTime,
    command: result.command,
    color: process.stdout.isTTY === true && env.NO_COLOR === undefined,
  };
}

interface InteractiveRenderInputs extends RenderSuccessInputs {
  renderCtx: RenderContext;
}

async function renderInteractiveSuccess(inputs: InteractiveRenderInputs): Promise<void> {
  const { result, invocation, renderCtx } = inputs;
  const { renderInk, renderInteractiveDashboard } = await import('../renderers/ink/index.js');
  if (!shouldLaunchDashboard(invocation)) {
    await renderInk(renderCtx, result);
    return;
  }
  await renderInteractiveDashboard(buildInteractiveDashboardOptions(inputs));
}

function buildInteractiveDashboardOptions(inputs: InteractiveRenderInputs): InteractiveDashboardOptions {
  const { result, state, invocation, version, renderCtx } = inputs;
  const runCommand = createInteractiveRuntimeSession({
    baseState: state,
    buildRuntimeContext,
    createInitialState,
    enforceRuntimeGates,
    parentInvocation: invocation,
    prepareRuntimeState,
    version,
  });
  const options: InteractiveDashboardOptions = {
    color: renderCtx.color,
    profileName: renderCtx.profileName,
    runCommand,
    version,
  };
  if (invocation.source !== 'bare') options.initialResult = result;
  if (state.profile?.provider) options.provider = state.profile.provider;
  if (state.profile?.apiUrl) options.apiUrl = state.profile.apiUrl;
  if (Object.keys(state.scope).length > 0) options.scope = state.scope;
  return options;
}

export function shouldLaunchDashboard(invocation: Invocation): boolean {
  return invocation.source === 'bare' || invocation.flags.interactive === true;
}

interface RenderErrorInputs {
  err: unknown;
  state: RuntimeState;
  invocation: Invocation;
  env: NodeJS.ProcessEnv;
  startTime: number;
}

function renderRuntimeError(inputs: RenderErrorInputs): ExitCode {
  const { err, state, invocation, env, startTime } = inputs;
  const renderCtx: RenderContext = {
    mode: state.mode,
    interactive: false,
    profileName: state.profileName,
    ...(Object.keys(state.scope).length > 0 ? { scope: state.scope } : {}),
    startTime,
    command: invocation.path,
    color: process.stdout.isTTY === true && env.NO_COLOR === undefined,
  };
  const error = err instanceof Error ? err : new Error(String(err));
  renderError(renderCtx, error);
  return exitCodeFor(error);
}

function extractScopeFlags(flags: CommandFlags): {
  user?: string;
  agentId?: string;
  namespace?: string;
  thread?: string;
} {
  const out: ReturnType<typeof extractScopeFlags> = {};
  if (typeof flags.user === 'string') out.user = flags.user;
  if (typeof flags['agent-id'] === 'string') out.agentId = flags['agent-id'];
  if (typeof flags.namespace === 'string') out.namespace = flags.namespace;
  if (typeof flags.thread === 'string') out.thread = flags.thread;
  return out;
}

interface BuildContextInputs {
  invocation: Invocation;
  config: CliConfigShape;
  paths: { dir: string; file: string };
  profile: CliProfileShape | null;
  scope: CliScopePartial;
  env: NodeJS.ProcessEnv;
  version: string;
  stdin: StdinReader;
}

function buildContext(inputs: BuildContextInputs): CommandContext {
  let cachedAdapter: AdapterHandle | null = null;
  return {
    command: inputs.invocation.path,
    positional: inputs.invocation.positional,
    flags: inputs.invocation.flags,
    config: inputs.config,
    configPath: inputs.paths.file,
    configDir: inputs.paths.dir,
    profile: inputs.profile,
    scope: inputs.scope,
    env: inputs.env,
    version: inputs.version,
    readStdin: () => inputs.stdin.read(),
    experimental: inputs.invocation.flags.experimental === true,
    getAdapter: async () => {
      if (cachedAdapter) return cachedAdapter;
      if (!inputs.profile) {
        throw new CliError(
          'usage',
          `command "${inputs.invocation.path}" needs a configured profile; run \`atomicmemory init\` or pass --provider and --api-url`,
        );
      }
      const { getAdapter } = await import('../adapters/registry.js');
      const adapter = await getAdapter(inputs.profile);
      await adapter.initialize();
      const capabilities = await adapter.getCapabilities();
      cachedAdapter = { adapter, capabilities };
      return cachedAdapter;
    },
  };
}
