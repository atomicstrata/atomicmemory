/**
 * @file `atomicmemory package <query>` — capability-gated context build.
 *
 * Spec flags (cli-spec.json) and handler must stay in sync:
 *   --token-budget, --format, --section, --api-key-stdin
 * No --filter-json or --reranker on package — those are search-only in
 * the v5 spec. The handler intentionally does NOT read them.
 *
 * --section is a renderer hint per v5 §"Package Semantics": it must NOT
 * change ranking, token selection, or memory inclusion. We surface it
 * back as `meta.section` so renderers (and agents) can see where the
 * caller intends to insert the produced text.
 *
 * Mem0 advertises extensions.package=false, so the gate fires before
 * the adapter is even called. AtomicMemory routes through
 * adapter.packageContext.
 *
 * meta.budget_constrained is emitted from the SDK's explicit
 * ContextPackage.budgetConstrained source of truth — never a CLI
 * heuristic.
 */

import { CliError } from '../../types.js';
import { assertCapability } from '../../capability-gate.js';
import { assertTokenBudget } from '../../cli/limits.js';
import type { AdapterPackageInput, AdapterSearchHit } from '../../adapters/types.js';
import type { CommandHandler } from '../types.js';
import { requireDynamicScope, requireScope } from '../scope.js';

const VALID_FORMATS = new Set(['flat', 'tiered', 'structured']);
const VALID_SECTIONS = new Set(['header', 'inline', 'footer']);

export const packageCommand: CommandHandler<{
  text: string;
  tokens: number;
  hits: AdapterSearchHit[];
  budgetConstrained: boolean;
}> = async (ctx) => {
  const query = ctx.positional.join(' ').trim();
  if (!query) throw new CliError('missing_input', 'package requires a query');
  const scope = requireScope(ctx);
  const { adapter, capabilities } = await ctx.getAdapter();
  assertCapability(capabilities, 'extensions.package', 'package command');
  // Dynamic scope check fires AFTER the extensions.package gate so
  // a Mem0 invocation surfaces unsupported_capability (the more
  // informative diagnosis) rather than a missing-scope-field error
  // for an operation the provider doesn't even support.
  requireDynamicScope(ctx, 'package', capabilities);

  const input: AdapterPackageInput = { query, scope };
  if (typeof ctx.flags['token-budget'] === 'number') {
    assertTokenBudget(ctx.flags['token-budget'], capabilities);
    input.tokenBudget = ctx.flags['token-budget'];
  }
  let format: 'flat' | 'tiered' | 'structured' | undefined;
  if (typeof ctx.flags.format === 'string') {
    if (!VALID_FORMATS.has(ctx.flags.format)) {
      throw new CliError(
        'usage',
        `--format must be flat|tiered|structured; got "${ctx.flags.format}"`,
      );
    }
    format = ctx.flags.format as 'flat' | 'tiered' | 'structured';
    input.format = format;
  }
  let section: 'header' | 'inline' | 'footer' | undefined;
  if (typeof ctx.flags.section === 'string') {
    if (!VALID_SECTIONS.has(ctx.flags.section)) {
      throw new CliError(
        'usage',
        `--section must be header|inline|footer; got "${ctx.flags.section}"`,
      );
    }
    section = ctx.flags.section as 'header' | 'inline' | 'footer';
  }

  const pkg = await adapter.packageContext(input);

  const meta: Record<string, unknown> = {};
  if (input.tokenBudget !== undefined) meta.token_budget = input.tokenBudget;
  if (format !== undefined) meta.format = format;
  if (section !== undefined) meta.section = section;
  meta.budget_constrained = pkg.budgetConstrained;

  return {
    command: 'package',
    data: pkg as unknown as {
      text: string;
      tokens: number;
      hits: AdapterSearchHit[];
      budgetConstrained: boolean;
    },
    count: pkg.hits.length,
    meta,
  };
};
