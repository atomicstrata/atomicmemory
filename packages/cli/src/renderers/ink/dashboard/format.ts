/**
 * @file Human dashboard formatting for command results. The dashboard
 * still receives the same typed CommandResult envelopes as one-shot
 * renders, but it summarizes high-volume commands into readable
 * terminal output.
 */

import type { CommandResult } from '../../../types.js';
import { withCapturedConsoleOutput } from './console-capture.js';
import { padEnd } from './menu.js';
import { scopeSummary } from './session.js';
import type {
  ConfigShowData,
  DoctorResultData,
  IngestResultData,
} from './types.js';

const MAX_COMMAND_RESULT_CHARS = 12000;

export function formatDashboardCommandResult(result: CommandResult<unknown>, captured = ''): string {
  const renderedData = humanCommandData(result) ?? (
    typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? null, jsonReplacer, 2)
  );
  const events = (result.events ?? []).map((event) => `[${event.type}] ${event.message}`);
  const rendered = withCapturedConsoleOutput([...events, renderedData].filter((line) => line.length > 0).join('\n'), captured);
  if (rendered.length <= MAX_COMMAND_RESULT_CHARS) return rendered;
  return `${rendered.slice(0, MAX_COMMAND_RESULT_CHARS)}\n...truncated after ${MAX_COMMAND_RESULT_CHARS} characters; run the command outside interactive mode for the complete output.`;
}

export function formatCommandError(err: unknown, captured = ''): string {
  return withCapturedConsoleOutput(err instanceof Error ? err.message : String(err), captured);
}

function humanCommandData(result: CommandResult<unknown>): string | undefined {
  if (result.command === 'config show' && isConfigShowData(result.data)) {
    return formatConfigShowResult(result.data);
  }
  if (result.command === 'doctor' && isDoctorResultData(result.data)) {
    return formatDoctorResult(result.data);
  }
  if (['add', 'ingest', 'import'].includes(result.command) && isIngestResultData(result.data)) {
    return formatIngestResult(result.data);
  }
  return undefined;
}

function formatConfigShowResult(data: ConfigShowData): string {
  const profileNames = Object.keys(data.profiles).sort((a, b) => {
    if (a === data.activeProfile) return -1;
    if (b === data.activeProfile) return 1;
    return a.localeCompare(b);
  });
  const lines = [
    'config',
    `schema version  ${data.schema_version}`,
    `active profile  ${data.activeProfile}`,
    `profiles        ${profileNames.length === 0 ? 'none' : profileNames.length}`,
  ];

  if (profileNames.length === 0) return lines.join('\n');

  lines.push('');
  for (const name of profileNames) {
    const profile = data.profiles[name] ?? {};
    const active = name === data.activeProfile ? ' (active)' : '';
    lines.push(`profile ${name}${active}`);
    lines.push(`  ${padEnd('provider', 14)}${profile.provider ?? 'missing'}`);
    lines.push(`  ${padEnd('trust surface', 14)}${profile.trustSurface ?? 'missing'}`);
    lines.push(`  ${padEnd('api url', 14)}${profile.apiUrl ?? 'missing'}`);
    lines.push(`  ${padEnd('scope', 14)}${scopeSummary(profile.scope)}`);
    lines.push(`  ${padEnd('output', 14)}${profile.output ?? 'default'}`);
    lines.push(`  ${padEnd('api key', 14)}${profile.apiKey ? 'configured (redacted)' : 'not saved'}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function formatDoctorResult(data: DoctorResultData): string {
  const failed = data.checks.filter((check) => !check.ok);
  const passed = data.checks.filter((check) => check.ok);
  const summary = [
    `mode ${data.mode}`,
    `checks ${passed.length} ok / ${failed.length} fail`,
    data.fix ? 'fix=on' : undefined,
    data.fixedAny ? 'fixed' : undefined,
  ].filter((part): part is string => part !== undefined).join('  ');

  const lines = [`doctor ${data.ok ? 'ready' : 'needs attention'}`, summary];
  if (failed.length > 0) lines.push('', 'needs attention', ...failed.map(formatDoctorCheck));
  if (passed.length > 0) lines.push('', 'passed', ...passed.map(formatDoctorCheck));
  return lines.join('\n');
}

function formatDoctorCheck(check: DoctorResultData['checks'][number]): string {
  const state = check.ok ? '✓' : '✗';
  const label = `${state}   ${check.id}`.padEnd(32);
  const fixed = check.fixed === true ? '  fixed' : '';
  const detail = check.detail ? formatDoctorDetail(check.detail) : '';
  return `${label}${detail}${fixed}`.trimEnd();
}

function formatDoctorDetail(detail: string): string {
  return stripCurrentWorkingDirectory(detail)
    .replace(/file:.*\/atomicmemory-sdk \(built\)/, 'local SDK built')
    .replace(/skill=.*\/atomicmemory\/packages\/cli\/SKILL\.md/i, 'skill=packages/cli/SKILL.md');
}

function formatIngestResult(data: IngestResultData): string {
  const changed = data.created.length + data.updated.length;
  if (changed === 0 && data.unchanged.length === 0) {
    return [
      'No memory stored.',
      'The provider accepted the request but did not create or update a memory.',
      'Try adding a more specific fact, preference, or piece of context.',
    ].join('\n');
  }

  const lines = [`Stored ${changed} ${changed === 1 ? 'memory' : 'memories'}.`];
  if (data.created.length > 0) lines.push(`created: ${data.created.join(', ')}`);
  if (data.updated.length > 0) lines.push(`updated: ${data.updated.join(', ')}`);
  if (data.unchanged.length > 0) lines.push(`unchanged: ${data.unchanged.join(', ')}`);
  return lines.join('\n');
}

function isIngestResultData(data: unknown): data is IngestResultData {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return Array.isArray(record.created) && Array.isArray(record.updated) && Array.isArray(record.unchanged);
}

function isConfigShowData(data: unknown): data is ConfigShowData {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.schema_version === 'string' &&
    typeof record.activeProfile === 'string' &&
    record.profiles !== null &&
    typeof record.profiles === 'object' &&
    !Array.isArray(record.profiles)
  );
}

function isDoctorResultData(data: unknown): data is DoctorResultData {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.ok === 'boolean' &&
    typeof record.mode === 'string' &&
    typeof record.fix === 'boolean' &&
    typeof record.fixedAny === 'boolean' &&
    Array.isArray(record.checks)
  );
}

function stripCurrentWorkingDirectory(value: string): string {
  const cwd = normalizePath(process.cwd());
  if (!cwd) return value;
  const escaped = escapeRegExp(`${cwd}/`);
  return normalizePath(value).replace(new RegExp(escaped, 'gi'), '');
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
