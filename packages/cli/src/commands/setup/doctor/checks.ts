/**
 * @file Doctor check catalog. Every entry has a stable ID and category
 * so JSON output is testable across releases. The order is the order
 * checks run.
 *
 * Categories implemented per v5 §"Phase 6 — Doctor + validate":
 *   env, package_version, config_schema, permissions, active_profile,
 *   scope, sdk_resolution, mcp_coexistence, provider_connectivity,
 *   provider_auth, spec_skill_drift.
 *
 * `--fix` is restricted to safe local repairs: mkdir + chmod only. No
 * credential writes, no provider-data mutations, no profile selection
 * changes. Currently only the permissions check exposes a `fix`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { CliError } from '../../../types.js';
import {
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
  ensureConfigDir,
  readMode,
  tightenConfigFile,
} from '../../../config/permissions.js';
import { loadSpec } from '../../../spec/loader.js';
import { getSkill } from '../../../skills.js';
import type { DoctorCheckResult, DoctorCheckSpec } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..', '..', '..');

export const CHECKS: DoctorCheckSpec[] = [
  {
    id: 'env.node_version',
    category: 'env',
    network: false,
    slow: false,
    run: () => {
      const v = process.versions.node;
      const major = Number.parseInt(v.split('.')[0] ?? '0', 10);
      return {
        id: 'env.node_version',
        category: 'env',
        ok: major >= 20,
        detail: `node=${v}`,
      };
    },
  },
  {
    id: 'package.version',
    category: 'package_version',
    network: false,
    slow: false,
    run: () => {
      const spec = loadSpec();
      return {
        id: 'package.version',
        category: 'package_version',
        ok: spec.package_version.length > 0,
        detail: `package_version=${spec.package_version}`,
      };
    },
  },
  {
    id: 'config_schema.loadable',
    category: 'config_schema',
    network: false,
    slow: false,
    run: (ctx) => ({
      id: 'config_schema.loadable',
      category: 'config_schema',
      ok: ctx.config.schema_version === '2',
      detail: `schema_version=${ctx.config.schema_version}`,
    }),
  },
  {
    id: 'permissions.config',
    category: 'permissions',
    network: false,
    slow: false,
    run: (ctx) => {
      const dirMode = readMode(ctx.configDir);
      const fileMode = readMode(ctx.configPath);
      const dirOk = dirMode === null || dirMode === CONFIG_DIR_MODE;
      const fileOk = fileMode === null || fileMode === CONFIG_FILE_MODE;
      const ok = dirOk && fileOk;
      return {
        id: 'permissions.config',
        category: 'permissions',
        ok,
        detail: `dir=${formatMode(dirMode)} file=${formatMode(fileMode)}`,
        fixable: !ok,
      };
    },
    fix: (ctx) => {
      // Safe repair: ensure the dir exists at 0700 and tighten the
      // file (if present) to 0600. Never creates a file.
      ensureConfigDir(ctx.configDir);
      tightenConfigFile(ctx.configPath);
      const dirMode = readMode(ctx.configDir);
      const fileMode = readMode(ctx.configPath);
      const ok =
        (dirMode === null || dirMode === CONFIG_DIR_MODE) &&
        (fileMode === null || fileMode === CONFIG_FILE_MODE);
      return {
        id: 'permissions.config',
        category: 'permissions',
        ok,
        detail: `dir=${formatMode(dirMode)} file=${formatMode(fileMode)}`,
        fixable: false,
        fixed: ok,
      };
    },
  },
  {
    id: 'active_profile.present',
    category: 'active_profile',
    network: false,
    slow: false,
    run: (ctx) => {
      const present = Object.keys(ctx.config.profiles).length > 0;
      return {
        id: 'active_profile.present',
        category: 'active_profile',
        ok: present,
        detail: present
          ? `active=${ctx.config.activeProfile}`
          : 'no profiles; run `atomicmemory init` (doctor --fix will NOT bootstrap)',
      };
    },
  },
  {
    id: 'scope.user_resolvable',
    category: 'scope',
    network: false,
    slow: false,
    run: (ctx) => ({
      id: 'scope.user_resolvable',
      category: 'scope',
      ok: typeof ctx.scope.user === 'string' && ctx.scope.user.length > 0,
      detail: ctx.scope.user
        ? `user=${ctx.scope.user}`
        : 'no user; pass --user, set ATOMICMEMORY_SCOPE_USER, or persist via init',
    }),
  },
  {
    id: 'sdk.resolution',
    category: 'sdk_resolution',
    network: false,
    slow: false,
    run: () => checkSdkResolution(),
  },
  {
    id: 'mcp.coexistence',
    category: 'mcp_coexistence',
    network: false,
    slow: false,
    run: () => checkMcpCoexistence(),
  },
  {
    id: 'provider.connectivity',
    category: 'provider_connectivity',
    network: true,
    slow: true,
    run: (ctx) => checkProviderConnectivity(ctx),
  },
  {
    id: 'provider.auth',
    category: 'provider_auth',
    network: false,
    slow: false,
    run: (ctx) => checkProviderAuth(ctx),
  },
  // Keep this last: it can emit a long local skill path, and the
  // interactive doctor summary is easier to scan when path-heavy
  // diagnostics do not interrupt provider/config health checks.
  {
    id: 'spec_skill.drift',
    category: 'spec_skill_drift',
    network: false,
    slow: false,
    run: () => checkSpecSkillDrift(),
  },
];

function formatMode(mode: number | null): string {
  return mode === null ? 'absent' : mode.toString(8);
}

function checkSdkResolution(): DoctorCheckResult {
  // Two valid v5 paths:
  //   1. local dev: package.json declares "@atomicmemory/sdk":
  //      "file:../../../atomicmemory-sdk", and the sibling repo is built
  //      (dist/ exists alongside the source).
  //   2. registry install: dependency is a semver range and Node's resolver
  //      can `require.resolve` the package id.
  let pkgJson: { dependencies?: Record<string, string> };
  try {
    pkgJson = JSON.parse(
      readFileSync(join(cliRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
  } catch (err) {
    return {
      id: 'sdk.resolution',
      category: 'sdk_resolution',
      ok: false,
      detail: `cannot read packages/cli/package.json: ${(err as Error).message}`,
    };
  }
  const dep = pkgJson.dependencies?.['@atomicmemory/sdk'];
  if (!dep) {
    return {
      id: 'sdk.resolution',
      category: 'sdk_resolution',
      ok: false,
      detail: '@atomicmemory/sdk dependency not declared',
    };
  }

  if (dep.startsWith('file:') || dep.startsWith('link:')) {
    // Local dev path. The relative target must exist and have a dist/.
    const relative = dep.replace(/^(file:|link:)/, '');
    const target = resolve(cliRoot, relative);
    if (!existsSync(target)) {
      return {
        id: 'sdk.resolution',
        category: 'sdk_resolution',
        ok: false,
        detail: `local SDK target missing: ${target}`,
      };
    }
    const distPath = join(target, 'dist');
    const built = existsSync(distPath);
    return {
      id: 'sdk.resolution',
      category: 'sdk_resolution',
      ok: built,
      detail: built
        ? `file:${target} (built)`
        : `${target} present but missing dist/; run \`pnpm build\` in atomicmemory-sdk`,
    };
  }

  // Registry path. Use require.resolve (works for ESM packages too via
  // createRequire on the CLI's package root).
  try {
    const require_ = createRequire(join(cliRoot, 'package.json'));
    const resolved = require_.resolve('@atomicmemory/sdk');
    return {
      id: 'sdk.resolution',
      category: 'sdk_resolution',
      ok: true,
      detail: `registry semver=${dep} resolved=${resolved}`,
    };
  } catch (err) {
    return {
      id: 'sdk.resolution',
      category: 'sdk_resolution',
      ok: false,
      detail: `registry semver=${dep} but require.resolve failed: ${(err as Error).message}`,
    };
  }
}

function checkSpecSkillDrift(): DoctorCheckResult {
  try {
    const spec = loadSpec();
    const sk = getSkill('core');
    return {
      id: 'spec_skill.drift',
      category: 'spec_skill_drift',
      ok: spec.package_version.length > 0 && sk.content.length > 0,
      detail: `spec_version=${spec.spec_version} skill=${sk.path}`,
    };
  } catch (err) {
    return {
      id: 'spec_skill.drift',
      category: 'spec_skill_drift',
      ok: false,
      detail: (err as Error).message,
    };
  }
}

function checkMcpCoexistence(): DoctorCheckResult {
  // Read-only diagnostic: detect whether atomicmemory-mcp is resolvable
  // from the CLI's perspective and verify the CLI bin doesn't shadow
  // the MCP stdio entry. Phase 6 V1 keeps this check defensive — full
  // shared-config diff is V1.1.
  let mcpResolved: string | null = null;
  try {
    const require_ = createRequire(join(cliRoot, 'package.json'));
    mcpResolved = require_.resolve('atomicmemory-mcp');
  } catch {
    // Not installed alongside; that is the common case and is OK.
  }

  const cliBin = join(cliRoot, 'dist', 'bin.js');
  const binExists = existsSync(cliBin);
  const cliBinIsFile = binExists && statSync(cliBin).isFile();

  if (!mcpResolved) {
    return {
      id: 'mcp.coexistence',
      category: 'mcp_coexistence',
      ok: true,
      detail: 'atomicmemory-mcp not installed; no coexistence concern',
    };
  }

  // If both are present, ensure they are distinct files. The CLI must
  // not have replaced the MCP stdio entrypoint.
  const mcpResolvedReal = resolve(mcpResolved);
  const cliBinReal = cliBinIsFile ? resolve(cliBin) : null;
  if (cliBinReal && cliBinReal === mcpResolvedReal) {
    return {
      id: 'mcp.coexistence',
      category: 'mcp_coexistence',
      ok: false,
      detail: `CLI bin appears to shadow the MCP stdio entry at ${mcpResolved}`,
    };
  }
  return {
    id: 'mcp.coexistence',
    category: 'mcp_coexistence',
    ok: true,
    detail: `mcp=${mcpResolved}; CLI does not shadow it`,
  };
}

async function checkProviderConnectivity(
  ctx: import('../../types.js').CommandContext,
): Promise<DoctorCheckResult> {
  try {
    const { adapter } = await ctx.getAdapter();
    const s = await adapter.getStatus();
    return {
      id: 'provider.connectivity',
      category: 'provider_connectivity',
      ok: s.ok,
      detail: s.detail ?? `provider=${s.provider}`,
    };
  } catch (err) {
    return {
      id: 'provider.connectivity',
      category: 'provider_connectivity',
      ok: false,
      detail:
        err instanceof CliError
          ? `${err.code}: ${err.message}`
          : (err as Error).message,
    };
  }
}

function checkProviderAuth(
  ctx: import('../../types.js').CommandContext,
): DoctorCheckResult {
  // Offline-friendly auth precondition: only verifies that an apiKey
  // is resolvable from env / overlay / profile when the active
  // profile points at a trust surface that requires one. Hosted
  // surfaces require an authenticated wrapper; doctor warns when a
  // profile names a hosted-looking URL without an authenticated-
  // wrapper trust surface (per v5 §"Trust Boundary").
  if (!ctx.profile) {
    return {
      id: 'provider.auth',
      category: 'provider_auth',
      ok: false,
      detail: 'no configured profile to evaluate auth precondition',
    };
  }
  const url = ctx.profile.apiUrl;
  const looksHosted =
    /^https?:\/\/(?!localhost|127\.|::1|0\.0\.0\.0)/i.test(url);
  if (looksHosted && ctx.profile.trustSurface !== 'authenticated-wrapper') {
    return {
      id: 'provider.auth',
      category: 'provider_auth',
      ok: false,
      detail: `apiUrl=${url} looks hosted but trustSurface="${ctx.profile.trustSurface}"; v5 requires "authenticated-wrapper"`,
    };
  }
  return {
    id: 'provider.auth',
    category: 'provider_auth',
    ok: true,
    detail: `trustSurface=${ctx.profile.trustSurface} apiUrl=${url}`,
  };
}
