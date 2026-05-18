/**
 * @file Spec → commander program. Walks the typed cli-spec.json output of
 * loader.ts and registers every command (including hidden ones) on a
 * commander Program. The drift-check script (`check-spec-parser-drift.mjs`)
 * imports `buildProgram` from the compiled output and asserts the
 * resulting program agrees with cli-spec.json on every visible/hidden
 * command and every top-level option.
 *
 * Hidden commands are registered through commander's supported hidden
 * path: `parent.command(name, { hidden: true })`. Setting a `hidden`
 * field on the Command instance after the fact does NOT affect default
 * help output in commander 12 — that was the V0 mistake; do not bring it
 * back.
 *
 * Both `--foo` and `--no-foo` global entries are registered explicitly.
 * Commander 12 does NOT auto-derive negation from a positive declaration;
 * declaring only `--foo` and passing `--no-foo` raises "unknown option".
 * The drift checker enforces that the spec's full set of negation pairs
 * matches the parser.
 */

import { Command, Option } from 'commander';
import type {
  CliCommandSpec,
  CliChildCommandSpec,
  CliGlobalOptionSpec,
  CliSpec,
} from './loader.js';

export function buildProgram(spec: CliSpec): Command {
  const program = new Command();
  program
    .name('atomicmemory')
    .description('AtomicMemory CLI')
    .version(spec.package_version);

  registerGlobalOptions(program, spec.global_options);

  for (const cmd of spec.commands) {
    registerCommand(program, cmd);
  }

  return program;
}

function registerGlobalOptions(
  program: Command,
  options: CliGlobalOptionSpec[],
): void {
  // Declare every spec global option, including `--no-foo` negations.
  // Commander 12 does NOT auto-derive negation from a positive declaration;
  // both forms must be registered explicitly. The drift checker enforces
  // that the spec and the parser agree on the full set.
  for (const opt of options) {
    const declared = parseFlagDecl(opt.name);
    program.option(declared.commanderForm, opt.description);
  }
}

/**
 * Identify `--no-foo` declarations. Kept as an exported helper so the
 * drift check can reason about negation pairs symbolically.
 */
export function isNegationFlag(declaration: string): boolean {
  return /^--no-[a-z]/.test(declaration.trim());
}

function registerCommand(program: Command, spec: CliCommandSpec): void {
  // Commander needs the positional declarations on the same string as
  // the command name so it captures them as args. Without this commander
  // silently drops unknown positionals — the third-audit blocker.
  const nameWithArgs = composeNameWithArgs(spec.name, spec.args);
  const cmd = program
    .command(nameWithArgs, spec.hidden ? { hidden: true } : {})
    .description(spec.summary);

  for (const flag of spec.flags ?? []) {
    const decl = parseFlagDecl(flag);
    cmd.option(decl.commanderForm, decl.placeholderDescription);
  }

  if (spec.examples && spec.examples.length > 0) {
    const text = spec.examples.map((e) => `  ${e}`).join('\n');
    cmd.addHelpText('after', `\nExamples:\n${text}`);
  }

  if (spec.children && spec.children.length > 0) {
    for (const child of spec.children) {
      registerChildCommand(cmd, child, spec.hidden === true);
    }
  }
}

function composeNameWithArgs(name: string, args: string[] | undefined): string {
  if (!args || args.length === 0) return name;
  return `${name} ${args.join(' ')}`;
}

function registerChildCommand(
  parent: Command,
  child: CliChildCommandSpec,
  parentHidden: boolean,
): void {
  // Spec child names may contain spaces (e.g., "profile list"). Walk the
  // segments, ensuring intermediate-level commands exist along the way.
  // Intermediate and leaf children inherit the parent's hidden flag so a
  // hidden top-level command does not surface its children.
  const parts = child.name.split(/\s+/);
  let cursor: Command = parent;
  for (let i = 0; i < parts.length - 1; i++) {
    const segment = parts[i]!;
    const existing = cursor.commands.find((c) => c.name() === segment);
    if (existing) {
      cursor = existing;
    } else {
      cursor = cursor
        .command(segment, parentHidden ? { hidden: true } : {})
        .description(`${segment} subcommands`);
    }
  }
  const leafName = parts[parts.length - 1]!;
  const nameWithArgs = composeNameWithArgs(leafName, child.args);
  cursor
    .command(nameWithArgs, parentHidden ? { hidden: true } : {})
    .description(child.summary);
}

interface FlagDecl {
  commanderForm: string;
  placeholderDescription: string;
}

/**
 * Convert a spec flag string into a commander option declaration.
 *
 *   "--api-key-stdin"                      => "--api-key-stdin"          (boolean)
 *   "--limit N"                            => "--limit <n>"              (UPPERCASE placeholder)
 *   "--filter-json JSON"                   => "--filter-json <json>"     (UPPERCASE placeholder)
 *   "--file PATH|-"                        => "--file <path>"            (UPPERCASE placeholder, "-" is a literal alt)
 *   "--mode text|messages|verbatim"        => "--mode <mode>"            (lowercase enum literals -> use flag name)
 *
 * Heuristic: if the tail's first character is an uppercase letter, the
 * tail names a placeholder (N, JSON, PATH) and we slugify it. Otherwise
 * the tail is a list of literal choice values (text|messages|verbatim,
 * flat|tiered|structured) and we use the flag name itself as the
 * placeholder so help reads as `--mode <mode>` rather than `--mode <text>`.
 * The full original tail is preserved in the description.
 */
export function parseFlagDecl(decl: string): FlagDecl {
  const trimmed = decl.trim();
  const parts = trimmed.split(/\s+/);
  const flag = parts[0] ?? trimmed;

  if (parts.length === 1) {
    return { commanderForm: flag, placeholderDescription: '' };
  }

  const tail = parts.slice(1).join(' ');
  const placeholderName = derivePlaceholder(flag, tail);
  return {
    commanderForm: `${flag} <${placeholderName}>`,
    placeholderDescription: tail.includes('|') ? `one of: ${tail}` : tail,
  };
}

function derivePlaceholder(flag: string, tail: string): string {
  const head = tail.replace(/[\[\]<>()]/g, '').split(/[|\s]/)[0] ?? '';
  const firstChar = head[0] ?? '';
  if (firstChar >= 'A' && firstChar <= 'Z') {
    // Uppercase placeholder name (N, PATH, JSON, URL, ...) — slugify it.
    return slugifyToken(head);
  }
  // Lowercase enum literal list — use the flag's own name as the placeholder.
  return slugifyToken(flag.replace(/^--?/, ''));
}

function slugifyToken(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'value';
}

// Re-export Option for tests / future use.
