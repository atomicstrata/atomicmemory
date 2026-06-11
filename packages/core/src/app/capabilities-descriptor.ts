/**
 * @file Wire capabilities descriptor for `GET /v1/capabilities`.
 *
 * Single source of truth for what the running core advertises to a
 * protocol-level caller (e.g. a control-plane daemon) that negotiates at
 * startup WITHOUT the JavaScript SDK. The SDK ships an equivalent
 * `AtomicMemoryProvider.capabilities()` descriptor for in-process JS
 * callers (`packages/sdk/src/memory/atomicmemory-provider`); this is the
 * over-the-wire equivalent so a non-JS caller gets the same negotiation
 * surface.
 *
 * Wire encoding is snake_case (matching every other core response). The
 * descriptor is a frozen const, not scattered route literals, so the
 * route handler, the OpenAPI example, and the contract test all read one
 * object — drift between them is impossible.
 *
 * The literal is aspirational on its own, so `createApp` runs
 * `verifyCapabilitiesDescriptor` (see `verify-capabilities.ts`) at startup:
 * every advertised capability is checked against the genuinely-mounted memory
 * router routes (and, for `temporal`, the search schema). If an advertised
 * capability is not actually wired, startup FAILS rather than letting a caller
 * negotiate against a feature that does not exist.
 */

/** Ingest modes the core accepts. Mirrors the SDK provider's `ingestModes`. */
export type CoreIngestMode = 'text' | 'messages' | 'verbatim';

/** Extension feature flags exposed over the wire. */
export interface CoreCapabilityExtensions {
  /** `/v1/memories/health` liveness + config snapshot. */
  health: boolean;
  /** Per-version content-hash audit trail. */
  versioning: boolean;
  /** Temporal retrieval controls on `/v1/memories/search`. */
  temporal: boolean;
}

/**
 * The over-the-wire capabilities descriptor. snake_case keys are the
 * canonical wire contract; a Rust caller deserializes this directly.
 */
export interface CoreCapabilities {
  /** Contract/spec version this descriptor conforms to. */
  version: number;
  /** Ingest modes the core accepts on `/v1/memories/ingest{,/quick}`. */
  ingest_modes: CoreIngestMode[];
  /** Whether semantic search is offered (`/v1/memories/search`). */
  search: boolean;
  /** Retrieval strategy. Core is semantic (vector) retrieval. */
  retrieval: 'semantic';
  /**
   * Whether an LLM-free deterministic fast path exists
   * (`/v1/memories/search/fast`). True for core.
   */
  deterministic_fast_path: boolean;
  /** Feature-extension flags. Reflects what core actually supports. */
  extensions: CoreCapabilityExtensions;
}

/** Contract version this descriptor conforms to. */
const CAPABILITIES_VERSION = 1;

/**
 * The frozen capabilities descriptor served at `GET /v1/capabilities`.
 *
 * - `ingest_modes` matches the SDK provider's `ingestModes`: core's
 *   `/v1/memories/ingest` does full-extraction text/messages ingest, and
 *   `/v1/memories/ingest/quick` with `skip_extraction=true` does verbatim.
 * - `deterministic_fast_path` is true because `/v1/memories/search/fast`
 *   skips the LLM repair loop.
 * - `extensions.versioning` is true: core writes a per-version content
 *   hash to the audit trail and exposes version history.
 * - `extensions.temporal` is true: `/v1/memories/search` accepts temporal
 *   retrieval controls.
 */
export const CORE_CAPABILITIES: Readonly<CoreCapabilities> = Object.freeze({
  version: CAPABILITIES_VERSION,
  ingest_modes: ['text', 'messages', 'verbatim'],
  search: true,
  retrieval: 'semantic',
  deterministic_fast_path: true,
  extensions: Object.freeze({
    health: true,
    versioning: true,
    temporal: true,
  }),
}) as Readonly<CoreCapabilities>;
