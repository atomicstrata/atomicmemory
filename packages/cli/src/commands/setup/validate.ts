/**
 * @file `atomicmemory validate` — installed-binary diagnostic surface.
 * Per v5 §"Phase 6 — Doctor + validate": package metadata, spec
 * version, schema/runtime model parity, embedded skill metadata,
 * secret redaction, config-file safety, command-spec example sanity,
 * envelope shape, and behavioral redaction. Distinct from CI tests.
 *
 * Default behavior is offline-only (no network, no credentials
 * needed). `--online` adds provider connectivity/auth checks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { CliError, type CliProfile, type RenderContext } from '../../types.js';
import { loadSpec, type CliSpec } from '../../spec/loader.js';
import { getSkill } from '../../skills.js';
import { REDACTED_API_KEY, redactProfile } from '../../config/profiles.js';
import {
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
  readMode,
} from '../../config/permissions.js';
import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
} from '../../output/envelope.js';
import { parseInvocation } from '../../cli/parse-invocation.js';
import type { CommandHandler } from '../types.js';

interface ValidateCheck {
  id: string;
  category: string;
  ok: boolean;
  detail: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..', '..');

export const validate: CommandHandler<{
  ok: boolean;
  online: boolean;
  checks: ValidateCheck[];
}> = async (ctx) => {
  const checks: ValidateCheck[] = [
    checkPackageMetadata(),
    checkCommandSpec(),
    await checkCommandSpecExamples(),
    checkConfigSchemaPresent(),
    checkConfigSchemaParity(),
    checkSkillEmbedded(),
    checkSecretRedactionContract(),
    checkSecretRedactionBehavior(),
    checkOutputEnvelopeShape(),
    checkConfigFileSafety(ctx),
  ];

  const online = ctx.flags.online === true;
  if (online) {
    checks.push(await checkProviderConnectivity(ctx));
  }

  const ok = checks.every((c) => c.ok);
  return {
    command: 'validate',
    data: { ok, online, checks },
    count: checks.length,
    meta: { mode: online ? 'online' : 'offline' },
  };
};

function checkPackageMetadata(): ValidateCheck {
  try {
    const pkg = JSON.parse(
      readFileSync(join(cliRoot, 'package.json'), 'utf8'),
    ) as { name?: string; version?: string; bin?: Record<string, string> };
    const ok =
      pkg.name === '@atomicmemory/cli' &&
      typeof pkg.version === 'string' &&
      pkg.version.length > 0 &&
      Boolean(pkg.bin?.atomicmemory);
    return {
      id: 'package.metadata',
      category: 'package',
      ok,
      detail: `name=${pkg.name} version=${pkg.version} bin=${Object.keys(pkg.bin ?? {}).join(',') || '(none)'}`,
    };
  } catch (err) {
    return {
      id: 'package.metadata',
      category: 'package',
      ok: false,
      detail: (err as Error).message,
    };
  }
}

function checkCommandSpec(): ValidateCheck {
  const spec = loadSpec();
  return {
    id: 'command_spec.present',
    category: 'command_spec',
    ok: spec.spec_version.startsWith('5.') && spec.commands.length > 0,
    detail: `spec_version=${spec.spec_version} commands=${spec.commands.length}`,
  };
}

async function checkCommandSpecExamples(): Promise<ValidateCheck> {
  const spec = loadSpec();
  const visible = collectVisiblePaths(spec);
  let parsed = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const cmd of spec.commands) {
    for (const ex of cmd.examples ?? []) {
      const result = await checkSingleExample(ex, visible);
      if (result === 'parsed') parsed += 1;
      else if (result === 'skipped') skipped += 1;
      else failures.push(`${cmd.name}: ${result}: ${ex}`);
    }
  }

  const ok = failures.length === 0;
  const summary = `parsed=${parsed} skipped=${skipped} failures=${failures.length}`;
  return {
    id: 'command_spec.examples',
    category: 'command_spec',
    ok,
    detail: ok ? summary : `${summary}: ${failures.slice(0, 3).join('; ')}`,
  };
}

async function checkSingleExample(
  ex: string,
  visible: Set<string>,
): Promise<'parsed' | 'skipped' | string> {
  const index = ex.indexOf('atomicmemory');
  if (index < 0) return 'missing "atomicmemory" invocation';
  const prefix = ex.slice(0, index).trim();
  const tail = ex.slice(index + 'atomicmemory'.length).trim();
  if (tail.length > 0 && !matchVisiblePath(tail, visible)) {
    return 'unknown command path';
  }
  if (prefix.length > 0) return 'skipped';
  if (/[|<>&;`$]/.test(tail)) return 'skipped';
  const argv = splitWords(tail);
  const result = await parseInvocation(argv);
  if (result.error) return `parse error: ${result.error.message}`;
  return 'parsed';
}

function collectVisiblePaths(spec: CliSpec): Set<string> {
  const paths = new Set<string>();
  for (const cmd of spec.commands) {
    if (cmd.hidden) continue;
    paths.add(cmd.name);
    for (const child of cmd.children ?? []) {
      paths.add(`${cmd.name} ${child.name}`);
    }
  }
  return paths;
}

function matchVisiblePath(tail: string, visible: Set<string>): string | null {
  const tokens = tail.split(/\s+/);
  if (tokens.length >= 2) {
    const two = `${tokens[0]} ${tokens[1]}`;
    if (visible.has(two)) return two;
  }
  return tokens[0] && visible.has(tokens[0]) ? tokens[0] : null;
}

function splitWords(input: string): string[] {
  // Minimal shell-safe splitter. We only enter this path after rejecting
  // shell metacharacters ($, `, |, &, ;, <, >), so the input contains
  // only whitespace-separated tokens with optional double-quoted segments.
  const out: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (buf.length > 0) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function checkConfigSchemaPresent(): ValidateCheck {
  const schemaPath = join(cliRoot, 'config.schema.json');
  return {
    id: 'config_schema.present',
    category: 'config_schema',
    ok: existsSync(schemaPath),
    detail: schemaPath,
  };
}

function checkConfigSchemaParity(): ValidateCheck {
  // Defensive parity check: the runtime zod model in
  // src/config/schema.ts must declare the same top-level keys
  // (schema_version, activeProfile, profiles) as config.schema.json.
  // The full drift gate runs in CI via generate-config-schema:check;
  // this is a smoke check the installed binary can run.
  try {
    const json = JSON.parse(
      readFileSync(join(cliRoot, 'config.schema.json'), 'utf8'),
    ) as { properties?: Record<string, unknown> };
    const required = ['schema_version', 'activeProfile', 'profiles'];
    const missing = required.filter((k) => !json.properties?.[k]);
    return {
      id: 'config_schema.parity',
      category: 'config_schema',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? 'top-level keys present'
          : `missing: ${missing.join(', ')}`,
    };
  } catch (err) {
    return {
      id: 'config_schema.parity',
      category: 'config_schema',
      ok: false,
      detail: (err as Error).message,
    };
  }
}

function checkSkillEmbedded(): ValidateCheck {
  try {
    const sk = getSkill('core');
    const ok = sk.content.length > 0 && sk.content.includes('atomicmemory');
    return {
      id: 'skill.core.present',
      category: 'skill',
      ok,
      detail: sk.path,
    };
  } catch (err) {
    return {
      id: 'skill.core.present',
      category: 'skill',
      ok: false,
      detail: (err as Error).message,
    };
  }
}

function checkSecretRedactionContract(): ValidateCheck {
  const ok = REDACTED_API_KEY === '***';
  return {
    id: 'secret.redaction',
    category: 'secret',
    ok,
    detail: `REDACTED_API_KEY=${REDACTED_API_KEY}`,
  };
}

function checkSecretRedactionBehavior(): ValidateCheck {
  // Behavioral check: feed a representative profile carrying a real-looking
  // apiKey through the redaction helper, then prove the literal key is gone
  // from the serialized output and the documented sentinel is present. The
  // contract check above only asserts the sentinel constant; this one fails
  // if redactProfile ever stops applying it (e.g., regression that returns
  // the input unchanged).
  const realKey = `sk-validate-${'A'.repeat(24)}`;
  const profile: CliProfile = {
    provider: 'atomicmemory',
    apiUrl: 'https://example.invalid/api',
    trustSurface: 'self-hosted',
    apiKey: realKey,
  };
  const out = redactProfile(profile);
  const serialized = JSON.stringify(out);
  const realPresent = serialized.includes(realKey);
  const sentinelApplied =
    out.apiKey === REDACTED_API_KEY && serialized.includes('***');
  const ok = !realPresent && sentinelApplied;
  return {
    id: 'secret.redaction_behavior',
    category: 'secret',
    ok,
    detail: ok
      ? 'redactProfile replaces apiKey with sentinel'
      : `realPresent=${realPresent} sentinelApplied=${sentinelApplied}`,
  };
}

function checkOutputEnvelopeShape(): ValidateCheck {
  // Build representative success and error envelopes via the real builders
  // and assert the v5 wire fields are present and well-typed. Catches
  // regressions where envelope helpers stop populating duration_ms /
  // profile / count, or where error envelopes start leaking non-null data.
  const ctx = buildSampleRenderCtx();
  const success = buildSuccessEnvelope(
    ctx,
    { command: 'validate', data: { sample: true }, count: 1 },
    { sample: true },
  );
  const errEnv = buildErrorEnvelope(ctx, new CliError('usage', 'sample'));
  const fail = collectEnvelopeFailures(success, errEnv);
  return {
    id: 'output_envelope.shape',
    category: 'output_envelope',
    ok: fail.length === 0,
    detail: fail.length === 0
      ? 'success+error envelopes carry required v5 fields'
      : fail.join('; '),
  };
}

function buildSampleRenderCtx(): RenderContext {
  return {
    mode: 'agent',
    interactive: false,
    profileName: 'default',
    startTime: 0,
    command: 'validate',
    color: false,
  };
}

const REQUIRED_ENVELOPE_FIELDS = [
  'status',
  'command',
  'duration_ms',
  'profile',
  'count',
  'data',
] as const;

function collectEnvelopeFailures(
  success: ReturnType<typeof buildSuccessEnvelope>,
  errEnv: ReturnType<typeof buildErrorEnvelope>,
): string[] {
  const fail: string[] = [];
  for (const f of REQUIRED_ENVELOPE_FIELDS) {
    if (!(f in success)) fail.push(`success.${f} missing`);
    if (!(f in errEnv)) fail.push(`error.${f} missing`);
  }
  if (success.status !== 'success') fail.push('success.status != "success"');
  if (typeof success.duration_ms !== 'number') {
    fail.push('success.duration_ms not number');
  }
  if (errEnv.status !== 'error') fail.push('error.status != "error"');
  if (errEnv.data !== null) fail.push('error.data != null');
  if (errEnv.error?.code !== 'usage') fail.push('error.error.code != "usage"');
  return fail;
}

function checkConfigFileSafety(
  ctx: import('../types.js').CommandContext,
): ValidateCheck {
  const dirMode = readMode(ctx.configDir);
  const fileMode = readMode(ctx.configPath);
  const dirOk = dirMode === null || dirMode === CONFIG_DIR_MODE;
  const fileOk = fileMode === null || fileMode === CONFIG_FILE_MODE;
  return {
    id: 'config.file_safety',
    category: 'config',
    ok: dirOk && fileOk,
    detail: `dir=${formatMode(dirMode)} file=${formatMode(fileMode)}`,
  };
}

function formatMode(mode: number | null): string {
  return mode === null ? 'absent' : mode.toString(8);
}

async function checkProviderConnectivity(
  ctx: import('../types.js').CommandContext,
): Promise<ValidateCheck> {
  try {
    const { adapter } = await ctx.getAdapter();
    const s = await adapter.getStatus();
    return {
      id: 'provider.connectivity',
      category: 'provider',
      ok: s.ok,
      detail: s.detail ?? `provider=${s.provider}`,
    };
  } catch (err) {
    if (err instanceof CliError) {
      return {
        id: 'provider.connectivity',
        category: 'provider',
        ok: false,
        detail: `${err.code}: ${err.message}`,
      };
    }
    return {
      id: 'provider.connectivity',
      category: 'provider',
      ok: false,
      detail: (err as Error).message,
    };
  }
}
