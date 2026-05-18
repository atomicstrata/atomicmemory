/**
 * @file `atomicmemory ingest --mode text|messages|verbatim` — explicit
 * multi-mode ingest. Routes through adapter.ingestMemories.
 *
 * Per v5 §"Search Semantics" / "Stdin handling": stdin is read only
 * when --stdin is explicit (agent mode without --stdin is a usage error).
 * For verbatim mode, the Mem0 adapter throws unsupported_capability.
 */

import { CliError } from '../../types.js';
import { assertCapability } from '../../capability-gate.js';
import type {
  AdapterIngestInput,
  AdapterMessage,
} from '../../adapters/types.js';
import type { CommandHandler } from '../types.js';
import { requireDynamicScope, requireScope } from '../scope.js';

export const ingest: CommandHandler<{
  created: string[];
  updated: string[];
  unchanged: string[];
}> = async (ctx) => {
  const mode = (ctx.flags.mode as AdapterIngestInput['mode']) ?? 'text';
  if (mode !== 'text' && mode !== 'messages' && mode !== 'verbatim') {
    throw new CliError('usage', `invalid --mode "${String(mode)}"; expected text|messages|verbatim`);
  }

  const scope = requireScope(ctx);
  const { adapter, capabilities } = await ctx.getAdapter();
  // Dynamic scope: enforce provider-imposed scope requirements
  // (e.g., namespace, agent_id) before any ingest call. Falls back to
  // capabilities.requiredScope.default when no operation-specific
  // entry exists.
  requireDynamicScope(ctx, 'ingest', capabilities);
  // Defensive ingestModes gate (Mem0 advertises ['text','messages']).
  assertCapability(capabilities, `ingestModes.${mode}` as const, 'ingest');

  let payload: AdapterIngestInput;
  if (mode === 'messages') {
    payload = {
      mode,
      scope,
      messages: await resolveMessages(ctx),
    };
  } else {
    payload = {
      mode,
      scope,
      text: await resolveText(ctx),
    };
    if (mode === 'verbatim' && typeof ctx.flags.kind === 'string') {
      const kind = ctx.flags.kind as Exclude<AdapterIngestInput['kind'], undefined>;
      payload.kind = kind;
    }
  }

  const result = await adapter.ingestMemories(payload);
  return {
    command: 'ingest',
    data: result,
    count: result.created.length + result.updated.length,
    meta: { mode },
  };
};

async function resolveText(ctx: import('../types.js').CommandContext): Promise<string> {
  // v5 input precedence: file > positional content > stdin. Positional
  // text MUST win over --stdin so an agent that piped data but also
  // included a literal text arg gets the literal arg; --stdin is the
  // explicit fallback when no positional is given.
  if (typeof ctx.flags.file === 'string' && ctx.flags.file.length > 0) {
    const piped = ctx.flags.file === '-' ? (await ctx.readStdin()).trim() : null;
    if (piped !== null) {
      if (!piped) throw new CliError('missing_input', 'ingest --file - received no input');
      return piped;
    }
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(ctx.flags.file, 'utf8').trim();
    if (!content) throw new CliError('missing_input', 'ingest --file is empty');
    return content;
  }
  const fromArgs = ctx.positional.join(' ').trim();
  if (fromArgs.length > 0) return fromArgs;
  if (ctx.flags.stdin === true) {
    const piped = (await ctx.readStdin()).trim();
    if (!piped) throw new CliError('missing_input', 'ingest --stdin received no input');
    return piped;
  }
  throw new CliError('missing_input', 'ingest requires text via positional, --file, or --stdin');
}

async function resolveMessages(
  ctx: import('../types.js').CommandContext,
): Promise<AdapterMessage[]> {
  let raw: string;
  if (typeof ctx.flags.file === 'string' && ctx.flags.file.length > 0) {
    if (ctx.flags.file === '-') {
      raw = await ctx.readStdin();
    } else {
      const { readFileSync } = await import('node:fs');
      raw = readFileSync(ctx.flags.file, 'utf8');
    }
  } else if (ctx.flags.stdin === true) {
    raw = await ctx.readStdin();
  } else {
    throw new CliError('missing_input', 'ingest --mode messages requires --file or --stdin with JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError('usage', `messages payload is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new CliError('usage', 'messages payload must be a JSON array of {role, content}');
  }
  return parsed.map(toMessage);
}

function toMessage(raw: unknown): AdapterMessage {
  if (!raw || typeof raw !== 'object') {
    throw new CliError('usage', 'each message must be an object {role, content}');
  }
  const obj = raw as Record<string, unknown>;
  const role = obj.role;
  const content = obj.content;
  if (
    role !== 'user' &&
    role !== 'assistant' &&
    role !== 'system' &&
    role !== 'tool'
  ) {
    throw new CliError('usage', `message.role must be user|assistant|system|tool; got "${String(role)}"`);
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new CliError('usage', 'message.content must be a non-empty string');
  }
  const out: AdapterMessage = { role, content };
  if (typeof obj.name === 'string') out.name = obj.name;
  return out;
}
