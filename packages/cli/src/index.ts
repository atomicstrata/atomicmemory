/**
 * @file Library entry point for `@atomicmemory/cli`. Re-exports the v5
 * public surface that downstream packages may import. Programmatic
 * embedding is not the primary use case (the bin is), but the package
 * still ships these as named exports so consumers can wire CliError,
 * inspect the cli-spec.json document, or generate completion scripts
 * without spawning a subprocess.
 */

export {
  CliError,
  defaultExitCodeFor,
  type CliConfig,
  type CliErrorCode,
  type CliOutputEnvelope,
  type CliProfile,
  type CliScope,
  type CommandResult,
  type ExitCode,
  type OutputMode,
  type ProgressEvent,
  type ProviderCapabilities,
  type RenderContext,
  type TrustSurface,
} from './types.js';

export {
  loadSpec,
  parseSpec,
  type CliSpec,
  type CliCommandSpec,
  type CliChildCommandSpec,
  type CliGlobalOptionSpec,
} from './spec/loader.js';

export {
  generateCompletion,
  type CompletionShell,
  type CompletionOptions,
} from './spec/completions.js';

export {
  resolveOutputMode,
  type ResolveModeInputs,
} from './renderers/index.js';
