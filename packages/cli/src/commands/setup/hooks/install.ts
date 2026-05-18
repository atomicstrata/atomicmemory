/**
 * @file Install-plan generation for coding-agent AtomicMemory hooks.
 * Node is the recommended runtime; Python snippets are advanced
 * external-runner templates and include their own shell env check.
 */

import type { CommandResult } from '../../../types.js';
import type { CommandContext } from '../../types.js';
import {
  COMMON_REQUIRED_ENV,
  DEFAULT_RUNTIME,
  parseHost,
  parseRuntime,
  type HookHost,
  type HookRuntime,
  type HookSnippet,
  type HooksInstallPlan,
} from './types.js';

export async function installPlan(ctx: CommandContext): Promise<CommandResult<HooksInstallPlan>> {
  const host = parseHost(ctx.flags.host);
  const runtime = parseRuntime(ctx.flags.runtime);
  const commandTemplate = commandFor(runtime, host, '<event>');
  const snippets = host === 'codex'
    ? [codexSnippet(runtime, host)]
    : [claudeCodeSnippet(runtime, host)];

  return {
    command: 'hooks',
    data: {
      action: 'install',
      host,
      runtime,
      defaultRuntime: DEFAULT_RUNTIME,
      runtimeTier: runtime === DEFAULT_RUNTIME ? 'recommended' : 'advanced',
      installMode: 'manual-config',
      commandTemplate,
      requiredEnv: [
        ...COMMON_REQUIRED_ENV,
        ...(runtime === 'python'
          ? ['ATOMICMEMORY_PYTHON_HOOK_BIN pointing at a compatible Python hook runner']
          : []),
      ],
      snippets,
      notes: installNotes(runtime, host),
    },
    count: snippets.length,
    meta: {
      defaultRuntime: DEFAULT_RUNTIME,
      pythonRuntimeRequiresExternalRunner: runtime === 'python',
    },
  };
}

function commandFor(runtime: HookRuntime, host: HookHost, event: string): string {
  if (runtime === 'node') {
    return `atomicmemory hooks run ${event} --host ${host}`;
  }
  const inner = [
    'if [ -z "$ATOMICMEMORY_PYTHON_HOOK_BIN" ]; then',
    'echo "ATOMICMEMORY_PYTHON_HOOK_BIN is required" >&2;',
    'exit 2;',
    'fi;',
    `exec python "$ATOMICMEMORY_PYTHON_HOOK_BIN" ${event} --host ${host}`,
  ].join(' ');
  return `sh -c ${shellQuote(inner)}`;
}

function codexSnippet(runtime: HookRuntime, host: HookHost): HookSnippet {
  return {
    target: '~/.codex/config.toml or .codex/config.toml',
    language: 'toml',
    content: [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks.UserPromptSubmit]]',
      'matcher = ".*"',
      '',
      '[[hooks.UserPromptSubmit.hooks]]',
      'type = "command"',
      `command = ${tomlString(commandFor(runtime, host, 'user-prompt-submit'))}`,
      'timeout = 10',
      'statusMessage = "Searching AtomicMemory..."',
      '',
      '[[hooks.PostCompact]]',
      '',
      '[[hooks.PostCompact.hooks]]',
      'type = "command"',
      `command = ${tomlString(commandFor(runtime, host, 'post-compact'))}`,
      'timeout = 10',
      'statusMessage = "Saving AtomicMemory compact summary..."',
      '',
      '[[hooks.Stop]]',
      '',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      `command = ${tomlString(commandFor(runtime, host, 'stop'))}`,
      'timeout = 10',
    ].join('\n'),
  };
}

function claudeCodeSnippet(runtime: HookRuntime, host: HookHost): HookSnippet {
  const hooks = {
    hooks: {
      UserPromptSubmit: [hookEntry(commandFor(runtime, host, 'user-prompt-submit'), 10, 'Searching AtomicMemory...')],
      PostCompact: [hookEntry(commandFor(runtime, host, 'post-compact'), 10, 'Saving AtomicMemory compact summary...')],
      Stop: [hookEntry(commandFor(runtime, host, 'stop'), 10)],
    },
  };
  return {
    target: 'Claude Code hooks.json',
    language: 'json',
    content: JSON.stringify(hooks, null, 2),
  };
}

function hookEntry(command: string, timeout: number, statusMessage?: string) {
  return {
    hooks: [
      {
        type: 'command',
        command,
        ...(statusMessage ? { statusMessage } : {}),
        timeout,
      },
    ],
  };
}

function installNotes(runtime: HookRuntime, host: HookHost): string[] {
  const notes = [
    'Node is the recommended default because it is bundled with @atomicmemory/cli and shares the TypeScript SDK adapter.',
    'The generated snippets are manual config snippets; inspect and merge them into the host config you already manage.',
    // PATH verification: hook environments (Codex, Claude Code) are
    // commonly spawned with a stripped PATH compared to the
    // interactive shell that ran `atomicmemory hooks install`. Run
    // `command -v atomicmemory` from inside the host hook environment
    // to confirm the bundled CLI resolves there before relying on the
    // generated snippet.
    'PATH verification: run `command -v atomicmemory` from inside the host hook environment to confirm the bundled CLI resolves there. Hook environments often have a thinner PATH than the interactive shell that generated this snippet.',
  ];
  if (host === 'codex') {
    notes.push('Codex project-scoped .codex/config.toml hooks load only when the project is trusted.');
    // Stop-threshold guidance: the bundled Node runtime defaults to
    // STOP_MIN_ASSISTANT_CHARS=200, which was empirically tuned for
    // Claude Code's verbose stop payloads. Codex stop responses are
    // frequently shorter (terse acknowledgements, single-line
    // confirmations) and the 200 default would silently drop them as
    // `low_signal`. Operators who want those captured should set the
    // override before invoking the hook — we do NOT inject it into
    // the generated snippet so the operator's existing env stays
    // authoritative.
    notes.push('Stop threshold: Codex stop payloads are often shorter than the bundled 200-char default. Export `ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS=40` (or a value tuned to your workflow) in the host hook environment to capture them; the generated snippet does not set this for you.');
  }
  if (host === 'claude-code') {
    // The 200 default came from empirical tuning of the original
    // Claude Code shell hooks, which see verbose multi-paragraph
    // assistant responses. Calling that out here so operators don't
    // assume the threshold is arbitrary.
    notes.push('Stop threshold: the bundled Node runtime\'s STOP_MIN_ASSISTANT_CHARS=200 default was tuned for Claude Code\'s typical assistant responses (multi-paragraph). Override via `ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS` if your workflow produces consistently shorter turns you still want captured.');
  }
  if (runtime === 'python') {
    notes.push('Python is an advanced option and must provide a compatible hook runner at ATOMICMEMORY_PYTHON_HOOK_BIN.');
  }
  return notes;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
