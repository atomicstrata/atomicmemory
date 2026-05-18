/**
 * @file Renderer dispatch — owns the v5 output-mode precedence rule and the
 * mapping from resolved mode to the success/error renderer pair.
 *
 * Output-mode resolution order (v5 §"Output Semantics"):
 *   1. --agent or --output agent
 *   2. --json
 *   3. --output <mode>
 *   4. command default
 *
 * If conflicting flags are passed, the higher-precedence mode wins without
 * warning so command output stays deterministic.
 */

import { renderAgentError, renderAgentSuccess } from './agent.js';
import { renderJsonError, renderJsonSuccess } from './json.js';
import { renderQuietError, renderQuietSuccess } from './quiet.js';
import { renderTableError, renderTableSuccess } from './table.js';
import { renderTextError, renderTextSuccess } from './text.js';
import type {
  CommandResult,
  OutputMode,
  RenderContext,
} from '../types.js';

export interface ResolveModeInputs {
  agentFlag?: boolean;
  jsonFlag?: boolean;
  outputFlag?: OutputMode;
  commandDefault: OutputMode;
}

export function resolveOutputMode(inputs: ResolveModeInputs): OutputMode {
  if (inputs.agentFlag === true || inputs.outputFlag === 'agent') return 'agent';
  if (inputs.jsonFlag === true) return 'json';
  if (inputs.outputFlag) return inputs.outputFlag;
  return inputs.commandDefault;
}

interface RendererPair {
  success: <T>(ctx: RenderContext, r: CommandResult<T>) => void;
  error: (ctx: RenderContext, err: Error) => void;
}

const RENDERERS: Record<OutputMode, RendererPair> = {
  text: { success: renderTextSuccess, error: renderTextError },
  table: { success: renderTableSuccess, error: renderTableError },
  json: { success: renderJsonSuccess, error: renderJsonError },
  agent: { success: renderAgentSuccess, error: renderAgentError },
  quiet: { success: renderQuietSuccess, error: renderQuietError },
};

function selectRenderer(mode: OutputMode): RendererPair {
  return RENDERERS[mode];
}

export function renderSuccess<T>(
  ctx: RenderContext,
  result: CommandResult<T>,
): void {
  selectRenderer(ctx.mode).success(ctx, result);
}

export function renderError(ctx: RenderContext, err: Error): void {
  selectRenderer(ctx.mode).error(ctx, err);
}
