/**
 * @file Shared shapes for the v5 doctor diagnostic. Every check is a
 * pure function returning {id, category, ok, detail} plus optional
 * fix metadata. Stable IDs are required by v5 §"Phase 6 — Doctor +
 * validate" so JSON output is testable across releases.
 */

import type { CommandContext } from '../../types.js';

type DoctorCategory =
  | 'env'
  | 'package_version'
  | 'config_schema'
  | 'permissions'
  | 'active_profile'
  | 'scope'
  | 'provider_connectivity'
  | 'provider_auth'
  | 'sdk_resolution'
  | 'spec_skill_drift'
  | 'mcp_coexistence';

export interface DoctorCheckResult {
  id: string;
  category: DoctorCategory;
  ok: boolean;
  detail: string;
  /** True when --fix can repair this in a safe (mkdir/chmod-only) way. */
  fixable?: boolean;
  /** Set by the runner when --fix successfully repaired the issue. */
  fixed?: boolean;
}

export interface DoctorCheckSpec {
  id: string;
  category: DoctorCategory;
  /** Pulls a network connection — skipped on --offline. */
  network: boolean;
  /** Slow enough to skip on --quick. */
  slow: boolean;
  run(ctx: CommandContext): Promise<DoctorCheckResult> | DoctorCheckResult;
  /**
   * When --fix is passed and `run` returned ok:false with fixable:true,
   * this attempts the safe repair. Returns the post-repair check
   * result with `fixed` set when successful.
   */
  fix?(ctx: CommandContext): Promise<DoctorCheckResult> | DoctorCheckResult;
}

export type DoctorMode = 'full' | 'quick' | 'offline';
