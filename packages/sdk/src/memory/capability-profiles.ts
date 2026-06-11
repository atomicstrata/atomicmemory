/**
 * @file Capability profiles
 *
 * A capability profile is the minimum {@link Capabilities} a
 * {@link MemoryProvider} must satisfy for a given consumer's needs (for
 * example, an audited ingest→search→replay path that requires deterministic
 * verbatim storage and version pinning). It is expressed as a typed, partial
 * requirement set so a caller can gate a provider at wiring time with an
 * actionable diff instead of an opaque boolean.
 *
 * The SDK ships the generic mechanism; each consumer defines its own profile
 * constant against this type. Pure runtime code — no I/O, no provider
 * construction.
 */

import type { Capabilities, IngestInput } from './types';

/** A minimum capability requirement set a provider must satisfy. */
export interface CapabilityProfile {
  /** Ingest modes the provider must support (e.g. `'text'`, `'verbatim'`). */
  ingestModes: ReadonlyArray<IngestInput['mode']>;
  /**
   * Extension flags the provider must expose (`extensions.<flag> === true`).
   * `search` is not listed here — it is a core method every `MemoryProvider`
   * implements, so it is implied rather than gated.
   */
  extensions: ReadonlyArray<keyof Capabilities['extensions']>;
}

/**
 * A single unmet capability requirement, for actionable provider-rejection
 * errors.
 */
export interface CapabilityGap {
  /** Which requirement category is unmet. */
  kind: 'ingestMode' | 'extension';
  /** The specific ingest mode or extension flag that is missing. */
  requirement: string;
  /** Human-readable reason the requirement is unmet. */
  detail: string;
}

/**
 * Return every requirement in `profile` that `caps` fails to satisfy. An empty
 * array means the provider satisfies the profile. Use this to build actionable
 * errors ("provider X is missing verbatim ingest, missing versioning
 * extension") instead of an opaque boolean rejection.
 */
export function capabilityGaps(caps: Capabilities, profile: CapabilityProfile): CapabilityGap[] {
  const gaps: CapabilityGap[] = [];

  for (const mode of profile.ingestModes) {
    if (!caps.ingestModes.includes(mode)) {
      gaps.push({
        kind: 'ingestMode',
        requirement: mode,
        detail: `ingestModes must include '${mode}'`,
      });
    }
  }

  for (const extension of profile.extensions) {
    if (caps.extensions[extension] !== true) {
      gaps.push({
        kind: 'extension',
        requirement: extension,
        detail: `extensions.${extension} must be true`,
      });
    }
  }

  return gaps;
}

/** Whether `caps` satisfies every requirement in `profile`. */
export function satisfiesProfile(caps: Capabilities, profile: CapabilityProfile): boolean {
  return capabilityGaps(caps, profile).length === 0;
}
