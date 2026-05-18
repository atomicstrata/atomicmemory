/**
 * @file Argv → Invocation. Builds a commander program from
 * cli-spec.json, binds an action callback at every command/subcommand
 * leaf so we capture (path, positional, flags) into a closure
 * variable, and runs commander's parseAsync. Returns either an
 * Invocation or a normalized CliError describing what commander
 * rejected.
 */

import { Command, CommanderError } from 'commander';
import { CliError } from '../types.js';
import { buildProgram } from '../spec/commander-bridge.js';
import { loadSpec } from '../spec/loader.js';
import { normalizeCommanderFlags } from './flag-normalize.js';
import type { CommandFlags } from '../commands/types.js';

export interface Invocation {
  path: string;
  positional: string[];
  flags: CommandFlags;
  source?: 'bare' | 'help_flag' | 'version_flag';
}

interface ParseResult {
  invocation: Invocation | null;
  error: CliError | null;
}

export async function parseInvocation(argv: string[]): Promise<ParseResult> {
  const spec = loadSpec();
  const program = buildProgram(spec);
  // exitOverride / strict-arg policies must propagate to every
  // subcommand (commander 12 does NOT inherit these). Unknown options
  // and excess positionals must throw CommanderError, not be silently
  // ignored.
  applyToTree(program);
  // Suppress commander's own stderr writes; the v5 renderer is the
  // single owner of stdout/stderr output and prints its envelope
  // from the caught CommanderError.
  configureSilent(program);

  let captured: Invocation | null = null;
  bindActions(program, [], (i) => {
    captured = i;
  });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    return classifyParseError(err, program);
  }

  return { invocation: captured, error: null };
}

function classifyParseError(err: unknown, program: Command): ParseResult {
  if (err instanceof CommanderError) {
    return classifyCommanderError(err, program);
  }
  if (err instanceof CliError) {
    return { invocation: null, error: err };
  }
  return {
    invocation: null,
    error: new CliError('runtime', err instanceof Error ? err.message : String(err)),
  };
}

function classifyCommanderError(err: CommanderError, program: Command): ParseResult {
  // Bare `atomicmemory` (commander.help, exitCode 1) and explicit
  // `--help` (commander.helpDisplayed, exitCode 0) both dispatch to
  // the `help` command so v5's compact dashboard / agent envelope
  // renders through our renderer rather than commander's silenced
  // writeOut. Globals already captured on the program — preserve
  // them so `atomicmemory --agent` returns the agent envelope.
  if (err.code === 'commander.help') {
    return helpInvocation('help', program, 'bare');
  }
  if (err.code === 'commander.helpDisplayed') {
    return helpInvocation('help', program, 'help_flag');
  }
  // `--version` (commander.version, exitCode 0) routes to the
  // dedicated `version` command for the same reason.
  if (err.code === 'commander.version') {
    return helpInvocation('version', program, 'version_flag');
  }
  if (err.exitCode === 0) return { invocation: null, error: null };
  // commander prefixes its messages with "error: "; the renderer
  // adds its own prefix, so strip commander's to avoid the
  // doubled "error: error: ..." output.
  const message = err.message.replace(/^error:\s*/, '');
  return { invocation: null, error: new CliError('usage', message) };
}

function helpInvocation(
  path: 'help' | 'version',
  program: Command,
  source?: Invocation['source'],
): ParseResult {
  const flags = normalizeCommanderFlags(program.opts());
  return { invocation: { path, positional: [], flags, ...(source ? { source } : {}) }, error: null };
}

function applyToTree(parent: Command): void {
  parent.exitOverride();
  parent.allowUnknownOption(false);
  parent.allowExcessArguments(false);
  for (const child of parent.commands) {
    applyToTree(child);
  }
}

function configureSilent(parent: Command): void {
  parent.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  for (const child of parent.commands) {
    configureSilent(child);
  }
}

function bindActions(
  parent: Command,
  path: string[],
  onMatch: (i: Invocation) => void,
): void {
  for (const cmd of parent.commands) {
    const myPath = [...path, cmd.name()];
    cmd.action(function (this: Command, ...args: unknown[]) {
      const lastTwo = 2;
      const positionals: string[] = [];
      for (const a of args.slice(0, args.length - lastTwo)) {
        if (typeof a === 'string') positionals.push(a);
        else if (Array.isArray(a)) {
          for (const p of a) if (typeof p === 'string') positionals.push(p);
        }
      }
      const localOpts = (args[args.length - lastTwo] as Record<string, unknown>) ?? {};
      let root: Command = this;
      while (root.parent) root = root.parent;
      const merged = { ...root.opts(), ...localOpts };
      onMatch({
        path: myPath.join(' '),
        positional: positionals,
        flags: normalizeCommanderFlags(merged),
      });
    });
    bindActions(cmd, myPath, onMatch);
  }
}
