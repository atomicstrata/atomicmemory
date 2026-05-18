/**
 * @file cli-spec.json loader and zod-validated typed view. The spec is the
 * single source of truth for command metadata, option groups, examples,
 * output modes, capability requirements, and `help --json`. Commander
 * registration consumes the result of `loadSpec()` (Phase 2's
 * commander-bridge.ts); help text and completions also consume it.
 *
 * Per v5 §"Command Spec Source Of Truth": do not generate the spec from
 * commander introspection, do not hand-maintain a separate JSON help tree.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';

const OUTPUT_MODES = ['text', 'table', 'json', 'agent', 'quiet'] as const;

/**
 * commander-style positional argument declaration. Examples:
 *   "<query...>"  required variadic (search/package/add)
 *   "<id>"        required string (get/delete)
 *   "[name]"      optional string (config profile show)
 *   "[command...]" optional variadic (help)
 */
const argDeclSchema = z
  .string()
  .min(1)
  .regex(
    /^[\[<][a-zA-Z0-9_-]+(?:\.\.\.)?[\]>]$/,
    'positional must look like "<id>", "[name]", "<query...>", or "[command...]"',
  );

const childCommandSchema = z.object({
  name: z.string().min(1),
  usage: z.string().min(1),
  summary: z.string().min(1),
  args: z.array(argDeclSchema).optional(),
});

const commandSchema = z
  .object({
    name: z.string().min(1),
    usage: z.string().min(1),
    summary: z.string().min(1),
    category: z.string().min(1),
    allowed_outputs: z.array(z.enum(OUTPUT_MODES)).min(1),
    /**
     * Optional explicit default output mode. Phase 5 dispatch reads
     * this; when absent, defaults to `allowed_outputs[0]`. Used so
     * commands like `list` can default to `table` even though `text`
     * is also allowed.
     */
    default_output: z.enum(OUTPUT_MODES).optional(),
    /**
     * commander-style positional declarations (e.g. `<query...>`,
     * `<id>`, `[name]`). When present, commander-bridge appends them
     * to the command's name so commander captures them as positional
     * arguments. Without this metadata commander silently drops
     * unknown positionals — the Phase 5 third-audit blocker.
     */
    args: z.array(argDeclSchema).optional(),
    flags: z.array(z.string().min(1)).optional(),
    examples: z.array(z.string().min(1)).optional(),
    hidden: z.boolean().optional(),
    children: z.array(childCommandSchema).optional(),
  })
  .refine(
    (cmd) =>
      cmd.default_output === undefined ||
      cmd.allowed_outputs.includes(cmd.default_output),
    {
      message: 'default_output must be one of allowed_outputs',
      path: ['default_output'],
    },
  );

const globalOptionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

const cliSpecSchema = z.object({
  spec_version: z.string().min(1),
  package_name: z.string().min(1),
  package_version: z.string().min(1),
  global_options: z.array(globalOptionSchema).min(1),
  commands: z.array(commandSchema).min(1),
});

export type CliSpec = z.infer<typeof cliSpecSchema>;
export type CliCommandSpec = z.infer<typeof commandSchema>;
export type CliChildCommandSpec = z.infer<typeof childCommandSchema>;
export type CliGlobalOptionSpec = z.infer<typeof globalOptionSchema>;

/**
 * Locates `cli-spec.json` via `import.meta.url` so the path resolves
 * identically when running through tsx (from `src/spec/loader.ts`) and
 * compiled (from `dist/spec/loader.js`).
 */
function specPath(): URL {
  return new URL('../../cli-spec.json', import.meta.url);
}

let cached: CliSpec | null = null;

export function loadSpec(): CliSpec {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(specPath(), 'utf8'));
  cached = parseSpec(raw);
  return cached;
}

/** Re-parse on demand (used by tests). */
export function parseSpec(raw: unknown): CliSpec {
  const result = cliSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `cli-spec.json failed schema validation:\n${result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  enforceInvariants(result.data);
  return result.data;
}

function enforceInvariants(spec: CliSpec): void {
  if (!spec.spec_version.startsWith('5.')) {
    throw new Error(
      `cli-spec.json: spec_version must be 5.x for the v5 CLI; got "${spec.spec_version}"`,
    );
  }

  const seen = new Set<string>();
  for (const cmd of spec.commands) {
    if (seen.has(cmd.name)) {
      throw new Error(`cli-spec.json: duplicate top-level command "${cmd.name}"`);
    }
    seen.add(cmd.name);

    if (cmd.children) {
      const childSeen = new Set<string>();
      for (const child of cmd.children) {
        if (childSeen.has(child.name)) {
          throw new Error(
            `cli-spec.json: duplicate child "${child.name}" under "${cmd.name}"`,
          );
        }
        childSeen.add(child.name);
      }
    }
  }
}

/** Test-only: clear the module-level cache between unit tests. */
export function _resetSpecCache(): void {
  cached = null;
}
