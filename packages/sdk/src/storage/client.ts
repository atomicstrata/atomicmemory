/**
 * @file Concrete `StorageClient` implementation.
 *
 * Wraps `fetch` to call the direct storage API
 * (`/v1/storage/artifacts/*`). The SDK is server-side only —
 * `Authorization: Bearer <apiKey>` is sent from a trusted process;
 * browser callers must proxy through a server they control.
 *
 * Managed-mode bodies are restricted to known-length values
 * (`Buffer | Uint8Array | ArrayBuffer`) so the client can compute
 * `Content-Length` before sending — the server requires it. Streams
 * (`ReadableStream`, Node `Readable`) are explicitly rejected with
 * `streaming_body_not_supported`; `Blob` is rejected with
 * `unsupported_body_type` so the silent buffering needed to compute
 * `Content-Length` stays visible at the call site (convert with
 * `new Uint8Array(await blob.arrayBuffer())` first). Streaming +
 * resumable uploads land in a follow-up PR.
 *
 * Wire mapping: core emits snake_case (`artifact_id`,
 * `cascaded_document_ids`); the SDK's public types use camelCase for
 * the top-level handles (`artifactId`, `cascadedDocumentIds`). The
 * client is the single seam that translates.
 */

import {
  ArtifactInUseError,
  ArtifactNotFoundError,
  FilecoinDirectStorageNotSupportedError,
  PointerContentNotManagedError,
  StorageClientError,
  UnsupportedCapabilityError,
} from './errors.js';
import type { StorageClient } from './interfaces.js';
import type {
  ArtifactBody,
  ArtifactHead,
  ArtifactRef,
  DeleteArtifactOptions,
  DeleteArtifactResult,
  PutArtifactInput,
  PutManagedInput,
  StorageArtifactStatus,
  StorageCapabilities,
  StorageLifecycle,
  StoredArtifact,
  VerificationResult,
  VerifyArtifactOptions,
} from './types.js';

/** Caller-supplied configuration for the concrete client. */
export interface StorageClientConfig {
  apiUrl: string;
  apiKey: string;
  /** Optional fetch override — defaults to the Node global. */
  fetch?: typeof fetch;
  /** Owner scope for the caller. Sent as `X-AtomicMemory-User-Id`
   * on every storage request. The legacy `?user_id=` URL parameter
   * is not used — the server rejects it with 400
   * `legacy_user_id_unsupported`. */
  userId: string;
}

const METADATA_HEADER = 'X-AtomicMemory-Metadata';

/** Wire-shape JSON envelope the core route layer emits on errors. */
interface CoreErrorEnvelope {
  error_code?: string;
  error?: string;
  uri?: string;
  referenced_by_document_count?: number;
  allowed_schemes?: ReadonlyArray<string>;
}

export class ConcreteStorageClient implements StorageClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: StorageClientConfig) {
    if (!config.apiUrl) throw new Error('StorageClient: apiUrl is required');
    if (!config.apiKey) throw new Error('StorageClient: apiKey is required');
    if (!config.userId) throw new Error('StorageClient: userId is required');
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.userId = config.userId;
    this.fetchImpl = config.fetch ?? fetch;
  }

  async capabilities(): Promise<StorageCapabilities> {
    const res = await this.request('GET', '/v1/storage/capabilities');
    return (await res.json()) as StorageCapabilities;
  }

  async put(input: PutArtifactInput): Promise<StoredArtifact> {
    if (input.mode === 'pointer') return this.putPointer(input);
    return this.putManaged(input);
  }

  async get(ref: ArtifactRef): Promise<StoredArtifact> {
    const id = this.requireArtifactId(ref);
    const res = await this.request('GET', `/v1/storage/artifacts/${id}`, {}, id);
    return mapStoredArtifact((await res.json()) as Record<string, unknown>);
  }

  async getContent(ref: ArtifactRef): Promise<ArtifactBody> {
    const id = this.requireArtifactId(ref);
    return this.request('GET', `/v1/storage/artifacts/${id}/content`, {}, id);
  }

  async head(ref: ArtifactRef): Promise<ArtifactHead> {
    const id = this.requireArtifactId(ref);
    const res = await this.request('HEAD', `/v1/storage/artifacts/${id}`, {}, id);
    return mapHeadHeaders(res.headers, id);
  }

  async delete(
    ref: ArtifactRef,
    options?: DeleteArtifactOptions,
  ): Promise<DeleteArtifactResult> {
    const id = this.requireArtifactId(ref);
    const query = options?.policy ? `?policy=${encodeURIComponent(options.policy)}` : '';
    const res = await this.request('DELETE', `/v1/storage/artifacts/${id}${query}`, {}, id);
    return mapDeleteResult((await res.json()) as Record<string, unknown>);
  }

  async verify(
    ref: ArtifactRef,
    _options?: VerifyArtifactOptions,
  ): Promise<VerificationResult> {
    // `_options` is reserved for future verification depth choices;
    // the server ignores it in v1, so we do not serialize it on
    // the request.
    const id = this.requireArtifactId(ref);
    const res = await this.request('POST', `/v1/storage/artifacts/${id}/verify`, {}, id);
    return mapVerifyResult((await res.json()) as Record<string, unknown>);
  }

  private async putPointer(input: Extract<PutArtifactInput, { mode: 'pointer' }>): Promise<StoredArtifact> {
    const body = {
      mode: 'pointer' as const,
      uri: input.uri,
      content_type: input.contentType,
      ...(input.sizeBytes !== undefined ? { size_bytes: input.sizeBytes } : {}),
      ...(input.contentHash !== undefined ? { content_hash: input.contentHash } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    const res = await this.request('POST', '/v1/storage/artifacts', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return mapStoredArtifact((await res.json()) as Record<string, unknown>);
  }

  private async putManaged(input: PutManagedInput): Promise<StoredArtifact> {
    // `view` is a Uint8Array narrowed to exactly the caller's bytes —
    // `Buffer` and Uint8Array sub-views share a backing ArrayBuffer
    // with potentially much larger contents, so we MUST send the view
    // itself (or an exact ArrayBuffer slice). Sending `view.buffer`
    // would leak adjacent bytes and produce a body whose actual size
    // disagrees with `Content-Length`.
    const view = coerceManagedBody(input.body);
    const params = new URLSearchParams({ mode: 'managed' });
    if (input.discloseContentHash === true) params.set('disclose_content_hash', 'true');
    const headers: Record<string, string> = {
      'Content-Type': input.contentType,
      'Content-Length': String(view.byteLength),
    };
    if (input.metadata !== undefined) {
      headers[METADATA_HEADER] = encodeMetadataHeader(input.metadata);
    }
    const res = await this.request(
      'POST',
      `/v1/storage/artifacts?${params.toString()}`,
      // Cast: Node's fetch accepts Uint8Array as BodyInit, but the
      // shared lib.dom type predates that. Sending the view directly
      // is intentional — see the comment above coerceManagedBody.
      { headers, body: view as unknown as BodyInit },
    );
    return mapStoredArtifact((await res.json()) as Record<string, unknown>);
  }

  /**
   * Send a request to the storage API and map non-2xx responses to
   * typed errors. Callers receive the raw `Response` on success and
   * read the body themselves so streaming reads (e.g. getContent)
   * can stay zero-copy.
   *
   * Auth contract: owner identity travels on the
   * `X-AtomicMemory-User-Id` request header alongside the
   * deployment-wide `Authorization: Bearer <apiKey>`. The legacy
   * `?user_id=` URL parameter is NEVER serialized — the server's
   * auth middleware rejects it with 400 `legacy_user_id_unsupported`.
   *
   * Transport-level fetch failures (DNS, ECONNREFUSED, AbortError,
   * a misconfigured fetch impl that throws synchronously) are
   * wrapped as `StorageClientError({errorCode:'network_error',
   * status:0})` so callers can branch on a stable error contract
   * instead of catching arbitrary `TypeError`s.
   *
   * `artifactId`, when supplied, threads into the error mapper so
   * `ArtifactNotFoundError` / `ArtifactInUseError` /
   * `PointerContentNotManagedError` carry the id the caller already
   * knows. The capabilities route omits it (no artifact context).
   */
  private async request(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
    artifactId?: string,
  ): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'X-AtomicMemory-User-Id': this.userId,
          ...(init.headers ?? {}),
        },
        body: init.body,
      });
    } catch (cause) {
      throw new StorageClientError({
        message:
          `Network error while calling ${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        errorCode: 'network_error',
        status: 0,
        bodyText: '',
      });
    }
    if (res.ok) return res;
    await throwForResponse(res, artifactId);
    // Unreachable — throwForResponse always throws on non-ok.
    throw new StorageClientError({
      message: `unexpected non-ok response (${res.status})`,
      errorCode: 'unexpected_response',
      status: res.status,
      bodyText: '',
    });
  }

  private requireArtifactId(ref: ArtifactRef): string {
    if (!ref.artifactId) {
      throw new StorageClientError({
        message: 'ArtifactRef.artifactId is required for this operation in v1',
        errorCode: 'missing_artifact_id',
        status: 0,
        bodyText: '',
      });
    }
    return ref.artifactId;
  }
}

/** Closed enums the SDK consumes from HEAD response headers + JSON bodies. */
const STORAGE_MODES = ['pointer', 'managed'] as const;
const STORAGE_STATUSES: ReadonlyArray<StorageArtifactStatus> = [
  'stored', 'pending', 'available', 'unavailable',
  'deleting', 'deleted', 'delete_failed', 'failed',
];
const CONTENT_ENCODINGS = ['identity', 'aes_gcm'] as const;

function parseSize(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Project HEAD response headers into an `ArtifactHead`. Validates
 * mode + status against the SDK's closed enums; throws a typed
 * `StorageClientError({errorCode:'invalid_head_response'})` if the
 * server sends a value the SDK doesn't model. The previous shape
 * cast arbitrary header strings to the enum types, which silently
 * accepted unknown values and propagated them into user code.
 */
function mapHeadHeaders(headers: Headers, fallbackId: string): ArtifactHead {
  const modeRaw = headers.get('x-atomicmemory-storage-mode');
  const statusRaw = headers.get('x-atomicmemory-storage-status');
  if (modeRaw === null || !(STORAGE_MODES as ReadonlyArray<string>).includes(modeRaw)) {
    throw new StorageClientError({
      message:
        `head(): server returned an unrecognized x-atomicmemory-storage-mode value ` +
        `('${modeRaw ?? '<missing>'}'). Expected one of: ${STORAGE_MODES.join(', ')}.`,
      errorCode: 'invalid_head_response',
      status: 200,
      bodyText: '',
    });
  }
  if (statusRaw === null || !(STORAGE_STATUSES as ReadonlyArray<string>).includes(statusRaw)) {
    throw new StorageClientError({
      message:
        `head(): server returned an unrecognized x-atomicmemory-storage-status value ` +
        `('${statusRaw ?? '<missing>'}'). Expected one of: ${STORAGE_STATUSES.join(', ')}.`,
      errorCode: 'invalid_head_response',
      status: 200,
      bodyText: '',
    });
  }
  return {
    artifactId: headers.get('x-atomicmemory-artifact-id') ?? fallbackId,
    provider: headers.get('x-atomicmemory-provider') ?? '',
    mode: modeRaw as 'pointer' | 'managed',
    status: statusRaw as StorageArtifactStatus,
    sizeBytes: parseSize(headers.get('content-length')),
    contentType: headers.get('content-type'),
  };
}

/**
 * Narrow a caller-supplied body to a `Uint8Array` view that covers
 * exactly the caller's bytes. Buffer / Uint8Array sub-views keep
 * their `byteOffset` + `byteLength` here so the request layer never
 * sends adjacent bytes from the backing ArrayBuffer.
 *
 * Parameter is `unknown` (not the static `PutManagedInput['body']`
 * type) so the runtime checks guard untyped JS callers too — TS
 * already removed Blob and stream types from the public input, but
 * a JS caller could still hand us a Blob or a stream object.
 */
function coerceManagedBody(body: unknown): Uint8Array {
  if (Buffer.isBuffer(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    // Blob is async-coerce only via arrayBuffer(); reject here and
    // let callers convert deliberately so the client never silently
    // buffers the entire Blob.
    throw new StorageClientError({
      message:
        'StorageClient.put: Blob input must be converted to Buffer / Uint8Array / ArrayBuffer ' +
        'before calling put(). Use `new Uint8Array(await blob.arrayBuffer())`.',
      errorCode: 'unsupported_body_type',
      status: 0,
      bodyText: '',
    });
  }
  // Stream / Readable / unknown — explicitly rejected. Streaming
  // body uploads land in the Streaming + Resumable Uploads PR.
  throw new StorageClientError({
    message:
      'StorageClient.put: only Buffer / Uint8Array / ArrayBuffer are accepted in v1. ' +
      'Streaming body uploads land in the Streaming + Resumable Uploads PR.',
    errorCode: 'streaming_body_not_supported',
    status: 0,
    bodyText: '',
  });
}

function encodeMetadataHeader(metadata: Record<string, string | number | boolean>): string {
  return Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64');
}

/**
 * Translate the snake_case wire response into the camelCase SDK
 * shape via an EXPLICIT named-key projection. Wire-only fields
 * (`stored_hash`, `delete_attempt_id`, etc.) the server formatter
 * already redacts; this layer drops anything not in the allowlist
 * even if a future server regression slipped a field through.
 *
 * Closed-set validation. `mode`, `status`, and `content_encoding`
 * are each checked against the enum the SDK actually models — an
 * unrecognized server / proxy / version-skew value throws
 * `StorageClientError({errorCode:'invalid_storage_response'})`
 * rather than silently producing a typed SDK object whose enum
 * fields lie about reality. Same discipline as HEAD header
 * validation.
 *
 * Required-field hardening. The wire contract guarantees
 * `artifact_id`, `provider`, `mode`, `status`, `content_encoding`,
 * `created_at`, `updated_at` on every read. Missing or wrong-type
 * values throw rather than defaulting to empty strings. Wire-only
 * `artifact_id` (no `artifactId` alias) — this is the SDK's snake→
 * camel seam, not a polyfill for callers that pre-translated.
 */
function mapStoredArtifact(raw: Record<string, unknown>): StoredArtifact {
  const artifactId = requireWireString(raw, 'artifact_id');
  const provider = requireWireString(raw, 'provider');
  const mode = requireWireEnum(raw, 'mode', STORAGE_MODES) as 'pointer' | 'managed';
  const status = requireWireEnum(raw, 'status', STORAGE_STATUSES) as StorageArtifactStatus;
  const contentEncoding = requireWireEnum(
    raw, 'content_encoding', CONTENT_ENCODINGS,
  ) as 'identity' | 'aes_gcm';
  const createdAt = requireWireString(raw, 'created_at');
  const updatedAt = requireWireString(raw, 'updated_at');
  const out: StoredArtifact = {
    artifactId,
    provider,
    mode,
    uri: typeof raw.uri === 'string' ? raw.uri : null,
    status,
    sizeBytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : null,
    contentType: typeof raw.content_type === 'string' ? raw.content_type : null,
    contentEncoding,
    identifiers: (raw.identifiers as Record<string, string> | undefined) ?? {},
    lifecycle: (raw.lifecycle as StorageLifecycle | undefined) ?? {},
    metadata:
      (raw.metadata as Record<string, string | number | boolean> | undefined) ?? {},
    createdAt,
    updatedAt,
  };
  if (typeof raw.content_hash === 'string') out.contentHash = raw.content_hash;
  if (raw.provider_details && typeof raw.provider_details === 'object') {
    out.providerDetails = raw.provider_details as Record<string, unknown>;
  }
  if (raw.replication && typeof raw.replication === 'object') {
    out.replication = raw.replication as StoredArtifact['replication'];
  }
  if (raw.verification && typeof raw.verification === 'object') {
    out.verification = raw.verification as StoredArtifact['verification'];
  }
  if (raw.retrieval && typeof raw.retrieval === 'object') {
    out.retrieval = raw.retrieval as StoredArtifact['retrieval'];
  }
  return out;
}

function requireWireString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new StorageClientError({
      message:
        `mapStoredArtifact: server response is missing required \`${field}\` ` +
        '(or it is not a non-empty string). The storage API contract requires it.',
      errorCode: 'invalid_storage_response',
      status: 200,
      bodyText: '',
    });
  }
  return value;
}

function requireWireEnum<T extends string>(
  raw: Record<string, unknown>,
  field: string,
  allowed: ReadonlyArray<T>,
): T {
  const value = raw[field];
  if (typeof value !== 'string' || !(allowed as ReadonlyArray<string>).includes(value)) {
    throw new StorageClientError({
      message:
        `mapStoredArtifact: server response field \`${field}\` is not in the SDK's ` +
        `closed enum. Got '${String(value ?? '<missing>')}', expected one of: ${allowed.join(', ')}.`,
      errorCode: 'invalid_storage_response',
      status: 200,
      bodyText: '',
    });
  }
  return value as T;
}

/**
 * Translate the snake_case DELETE response envelope into the
 * camelCase SDK shape. Same discipline as `mapStoredArtifact`:
 *
 *   - require non-empty snake_case `artifact_id` (no camelCase
 *     alias polyfill — the wire is snake_case);
 *   - validate `status` against the closed `StorageArtifactStatus`
 *     enum;
 *   - throw `StorageClientError({errorCode:'invalid_storage_response'})`
 *     on missing / wrong-type / out-of-enum values rather than
 *     silently producing a typed SDK object whose fields lie.
 */
function mapDeleteResult(raw: Record<string, unknown>): DeleteArtifactResult {
  const artifactId = requireWireString(raw, 'artifact_id');
  const status = requireWireEnum(raw, 'status', STORAGE_STATUSES) as StorageArtifactStatus;
  const out: DeleteArtifactResult = { artifactId, status };
  if (Array.isArray(raw.cascaded_document_ids)) {
    out.cascadedDocumentIds = raw.cascaded_document_ids.map(String);
  }
  return out;
}

function mapVerifyResult(raw: Record<string, unknown>): VerificationResult {
  const kind = raw.kind;
  if (kind === 'verified') {
    return { kind: 'verified', details: (raw.details ?? {}) as Record<string, unknown> };
  }
  if (kind === 'failed') {
    return { kind: 'failed', reason: String(raw.reason ?? 'unknown failure') };
  }
  return { kind: 'unsupported', reason: String(raw.reason ?? 'unsupported') };
}

async function throwForResponse(res: Response, artifactId?: string): Promise<never> {
  const bodyText = await res.text();
  const envelope = parseEnvelope(bodyText);
  const code = envelope.error_code;
  const message = envelope.error ?? `request failed with status ${res.status}`;
  const id = artifactId ?? '';
  if (code === 'artifact_in_use') {
    throw new ArtifactInUseError({
      artifactId: id,
      referencedByDocumentCount: envelope.referenced_by_document_count ?? 0,
      bodyText,
    });
  }
  if (code === 'pointer_content_not_managed') {
    throw new PointerContentNotManagedError({
      artifactId: id,
      uri: envelope.uri ?? '',
      bodyText,
    });
  }
  if (code === 'filecoin_direct_storage_not_yet_supported') {
    throw new FilecoinDirectStorageNotSupportedError({ bodyText });
  }
  if (code === 'artifact_not_found' || res.status === 404) {
    throw new ArtifactNotFoundError({ artifactId: id, bodyText });
  }
  if (code === 'unsupported_capability') {
    throw new UnsupportedCapabilityError({
      capability: 'unknown',
      message,
      bodyText,
    });
  }
  throw new StorageClientError({
    message,
    errorCode: code ?? `http_${res.status}`,
    status: res.status,
    bodyText,
  });
}

function parseEnvelope(bodyText: string): CoreErrorEnvelope {
  if (bodyText.length === 0) return {};
  try {
    return JSON.parse(bodyText) as CoreErrorEnvelope;
  } catch {
    return {};
  }
}
