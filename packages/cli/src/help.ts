/**
 * @file Human-readable help renderer. As of Phase 2 the spec parsing is
 * delegated to the shared `src/spec/loader.ts` (zod-validated, cached);
 * this file no longer maintains its own duplicate parser.
 *
 * Phase 5 will replace the rendering layout with a fully spec-driven
 * generator that consumes commander introspection. Until then this
 * module continues to provide the V0-shaped grouped help output, but
 * sourced from the canonical loader so spec drift cannot happen.
 */

import { banner, bold, box, columns, dim } from './style.js';
import {
  loadSpec,
  type CliCommandSpec,
  type CliSpec,
} from './spec/loader.js';

const CLI_SPEC = loadSpec();

/**
 * Help-facing machine document. Hidden experimental commands are
 * excluded so `help --json` and any sanitized agent envelope cannot
 * accidentally surface unstable commands. Callers that need
 * the full spec (parser drift, capability gating, validate) call
 * `loadSpec()` from `./spec/loader.ts` directly.
 *
 * Per v5: post-V1 surfaces (lifecycle/audit/lessons/agents) must not
 * appear in default help, in `help --json`, or in generated
 * completions; cli-spec.json still carries them so that `--experimental`
 * dispatch and capability gates can find them.
 */
export function commandSpecDocument(): CliSpec {
  return {
    ...CLI_SPEC,
    commands: CLI_SPEC.commands.filter((c) => c.hidden !== true),
  };
}

export function commandTree(options: { includeHidden?: boolean } = {}): CliCommandSpec[] {
  return filterHidden(CLI_SPEC.commands, options.includeHidden === true);
}

export function renderHelp(command?: string, version = CLI_SPEC.package_version): string {
  if (command) {
    const spec = findCommand(command, true);
    if (!spec) return `Unknown command: ${command}`;
    return renderCommandHelp(spec);
  }

  return [
    banner(version),
    '',
    box('getting started', columns([
      [bold('atomicmemory init'), 'configure profile, provider URL, and default scope'],
      [bold('atomicmemory doctor'), 'verify config, connection, package, and integration health'],
      [bold('atomicmemory status'), 'show active provider, profile, scope, and capabilities'],
    ])),
    '',
    box('commands', [
      `${dim('pattern')}   atomicmemory <command> [args] [--profile NAME] [--user USER]`,
      `${dim('example')}   atomicmemory search "release policy" --namespace docs --limit 10`,
      '',
      ...columns([
        [bold('setup'), commandNames('init', 'config', 'hooks', 'completion')],
        [bold('diagnose'), commandNames('doctor', 'status', 'validate')],
        [bold('agent'), commandNames('skill', 'help', 'version')],
        [bold('memory'), commandNames('add', 'ingest', 'search', 'package', 'list', 'get', 'delete', 'import')],
      ]),
    ]),
    '',
    box('global options', columns(
      CLI_SPEC.global_options.map((option) => [bold(option.name), option.description]),
    )),
  ].join('\n');
}

function renderCommandHelp(spec: CliCommandSpec): string {
  return [
    spec.summary,
    '',
    'Usage:',
    `  ${spec.usage}`,
    ...(spec.flags?.length ? ['', 'Options:', ...spec.flags.map((flag) => `  ${flag}`)] : []),
    ...(spec.children?.length
      ? ['', 'Subcommands:', ...spec.children.map((child) => `  ${child.name.padEnd(14)} ${child.summary}`)]
      : []),
    ...(spec.examples?.length ? ['', 'Examples:', ...spec.examples.map((example) => `  ${example}`)] : []),
  ].join('\n');
}

function commandNames(...names: string[]): string {
  return names
    .filter((name) => findCommand(name, false))
    .join(' . ');
}

function findCommand(name: string, includeHidden: boolean): CliCommandSpec | undefined {
  for (const spec of commandTree({ includeHidden })) {
    if (spec.name === name) return spec;
    const child = spec.children?.find((candidate) => `${spec.name} ${candidate.name}` === name);
    if (child) {
      // Synthesize a minimal CliCommandSpec view from the child for the
      // V0 callers that expect this shape.
      return {
        name: child.name,
        usage: child.usage,
        summary: child.summary,
        category: spec.category,
        allowed_outputs: spec.allowed_outputs,
      } satisfies CliCommandSpec;
    }
  }
  return undefined;
}

function filterHidden(commands: CliCommandSpec[], includeHidden: boolean): CliCommandSpec[] {
  if (includeHidden) return commands;
  return commands.filter((command) => command.hidden !== true);
}
