/**
 * @file Shared types for the live Ink dashboard. Keeping these shapes
 * separate lets the React layout, command formatting, menu filtering,
 * and scroll math depend on the same contracts without importing the
 * full dashboard component.
 */

import type { CliScopePartial, CommandResult } from '../../../types.js';

export type TuiColor = string;

export interface CommandEvent {
  id: number;
  kind: 'error' | 'result' | 'system';
  title: string;
  body: string;
  durationMs?: number;
}

export interface CommandShortcut {
  command: string;
  label: string;
  hint: string;
}

export interface SessionLine {
  color: TuiColor | undefined;
  key: string;
  text: string;
}

export interface IngestResultData {
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface ConfigShowData {
  schema_version: string;
  activeProfile: string;
  profiles: Record<string, {
    provider?: string;
    apiUrl?: string;
    trustSurface?: string;
    scope?: CliScopePartial;
    output?: string;
    apiKey?: string;
  }>;
}

export interface DoctorResultData {
  ok: boolean;
  mode: string;
  fix: boolean;
  fixedAny: boolean;
  checks: Array<{
    category?: string;
    id: string;
    ok: boolean;
    detail?: string;
    fixed?: boolean;
  }>;
}

export interface InteractiveDashboardOptions {
  apiUrl?: string;
  color: boolean;
  initialResult?: CommandResult<unknown>;
  profileName: string;
  provider?: string;
  runCommand: (line: string) => Promise<CommandResult<unknown>>;
  scope?: CliScopePartial;
  version: string;
}
