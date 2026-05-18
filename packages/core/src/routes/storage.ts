/**
 * @file Direct storage API routes (`/v1/storage/*`).
 *
 * Step 3 added `GET /v1/storage/capabilities`; Step 5 adds the
 * artifact CRUD surface on top of the same router:
 *
 *   POST   /v1/storage/artifacts            pointer (JSON body) or
 *                                            ?mode=managed (raw bytes)
 *   GET    /v1/storage/artifacts/:id        public metadata
 *   GET    /v1/storage/artifacts/:id/content bytes (managed) or 409 (pointer)
 *   HEAD   /v1/storage/artifacts/:id        metadata via response headers
 *   DELETE /v1/storage/artifacts/:id?policy=...
 *   POST   /v1/storage/artifacts/:id/verify backend.head()-based shim
 *
 * Body parsing is per-route:
 *   * Pointer-mode put + verify use the standard JSON parser.
 *   * Managed-mode put uses `express.raw({ type: '*\/*' })` with the
 *     configured byte cap; the route extracts the caller-supplied
 *     `X-AtomicMemory-Metadata` header (base64-encoded JSON) and
 *     validates it against the decoded-JSON cap.
 *
 * Redaction posture: every public response runs through
 * `formatStoredArtifact` (or its sibling formatters) which projects
 * an allowlisted shape THEN `.strict()`-parses through the schema in
 * `STORAGE_RESPONSE_SCHEMAS`. Internal columns (`stored_hash`,
 * `last_error`, `delete_attempt_id`) never reach the wire.
 */

import express, { Router, type Request, type Response } from 'express';
import { handleRouteError } from './route-errors.js';
import { validateResponse } from '../middleware/validate-response.js';
import { STORAGE_RESPONSE_SCHEMAS } from './response-schema-map.js';
import {
  formatArtifactHeadHeaders,
  formatStoredArtifact,
} from './storage-response-formatters.js';
import {
  getStorageCapabilities,
  type StorageCapabilitiesSnapshot,
} from '../storage/storage-capabilities.js';
import {
  InvalidArtifactMetadataError,
  StorageArtifactNotFoundError,
} from '../services/storage-service-errors.js';
import {
  LegacyUserIdRejection,
  handleStorageError,
} from './storage-error-handlers.js';
import {
  validateArtifactMetadata,
  type ArtifactMetadata,
  type StorageService,
} from '../services/storage-service.js';
import { PutPointerBodySchema } from '../schemas/storage-schemas.js';

/** Composition-time inputs for the storage router. */
export interface StorageRouterOptions {
  capabilities: StorageCapabilitiesSnapshot;
  service: StorageService;
  /** Body cap for managed-mode uploads (bytes). */
  managedUploadMaxBytes: number;
}

const METADATA_HEADER = 'x-atomicmemory-metadata';
const METADATA_HEADER_MAX_ENCODED_BYTES = 8 * 1024;
const DEFAULT_JSON_LIMIT = '1mb';

export function createStorageRouter(opts: StorageRouterOptions): Router {
  const router = Router();
  router.use(validateResponse(STORAGE_RESPONSE_SCHEMAS));
  registerCapabilitiesRoute(router, opts.capabilities);
  registerPutArtifactRoute(router, opts);
  // HEAD MUST register before GET /:id — Express's auto-HEAD-from-GET
  // path is picked when the GET handler is registered first, which
  // suppresses our explicit `X-AtomicMemory-*` response headers.
  registerHeadArtifactRoute(router, opts.service);
  registerGetArtifactRoute(router, opts.service);
  registerGetArtifactContentRoute(router, opts.service);
  registerDeleteArtifactRoute(router, opts.service);
  registerVerifyArtifactRoute(router, opts.service);
  return router;
}

function registerCapabilitiesRoute(
  router: Router,
  snapshot: StorageCapabilitiesSnapshot,
): void {
  router.get('/capabilities', (_req: Request, res: Response) => {
    try {
      res.json(getStorageCapabilities(snapshot));
    } catch (error) {
      handleRouteError(res, 'get_storage_capabilities', error);
    }
  });
}

function registerPutArtifactRoute(
  router: Router,
  opts: StorageRouterOptions,
): void {
  const rawParser = express.raw({
    type: '*/*',
    limit: opts.managedUploadMaxBytes,
  });
  const jsonParser = express.json({ limit: DEFAULT_JSON_LIMIT });
  router.post('/artifacts', (req: Request, res: Response, next) => {
    if (req.query.mode === 'managed') return rawParser(req, res, next);
    return jsonParser(req, res, next);
  }, async (req: Request, res: Response) => {
    try {
      const userId = readUserId(req);
      if (req.query.mode === 'managed') {
        await handleManagedPut(req, res, opts.service, userId, opts.managedUploadMaxBytes);
        return;
      }
      await handlePointerPut(req, res, opts.service, userId);
    } catch (err) {
      if (handleStorageError(res, err)) return;
      handleRouteError(res, 'POST /v1/storage/artifacts', err);
    }
  });
}

async function handlePointerPut(
  req: Request,
  res: Response,
  service: StorageService,
  userId: string,
): Promise<void> {
  // Project-and-validate the pointer body through the strict schema
  // BEFORE persistence: this catches negative / fractional
  // `size_bytes`, empty `uri` / `content_type`, and unknown keys —
  // all of which would otherwise either insert a bad row or fail
  // the response-shape validation after the row was already stored.
  const parsed = PutPointerBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error_code: 'invalid_pointer_body',
      error: 'pointer-mode body failed validation',
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  // Re-validate metadata for the 4 KiB cap — `PutPointerBodySchema`
  // bounds the value types but the byte-size check is policy that
  // lives on the service-shared validator.
  validateArtifactMetadata(parsed.data.metadata);
  const row = await service.putPointer({
    userId,
    uri: parsed.data.uri,
    contentType: parsed.data.content_type,
    sizeBytes: parsed.data.size_bytes ?? null,
    contentHash: parsed.data.content_hash ?? null,
    metadata: parsed.data.metadata,
  });
  res.status(201).json(formatStoredArtifact(row));
}

async function handleManagedPut(
  req: Request,
  res: Response,
  service: StorageService,
  userId: string,
  maxBytes: number,
): Promise<void> {
  const lengthCheck = checkManagedContentLength(req, maxBytes);
  if (lengthCheck !== null) {
    res.status(lengthCheck.status).json({ error: lengthCheck.error });
    return;
  }
  const disclose = parseDiscloseFlag(req.query.disclose_content_hash);
  if (disclose === 'invalid') {
    res.status(400).json({
      error_code: 'invalid_disclose_content_hash',
      error: 'disclose_content_hash query parameter must be "true" or "false"',
    });
    return;
  }
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: 'request body is required' });
    return;
  }
  const row = await service.putManaged({
    userId,
    body,
    contentType: readManagedContentType(req),
    discloseContentHash: disclose,
    metadata: parseMetadataHeader(req),
  });
  res.status(201).json(formatStoredArtifact(row));
}

/**
 * Parse the `disclose_content_hash` query value with a closed
 * tri-state result: `true`, `false`, or `'invalid'`. The route maps
 * `'invalid'` to a 400 envelope so an unexpected value cannot
 * silently default to `false` (which would suppress
 * `content_hash` on the response without the caller realising).
 */
function parseDiscloseFlag(value: unknown): boolean | 'invalid' {
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return 'invalid';
}

function checkManagedContentLength(
  req: Request,
  maxBytes: number,
): { status: number; error: string } | null {
  const header = req.headers['content-length'];
  if (typeof header !== 'string') {
    return { status: 411, error: 'Content-Length is required for managed uploads' };
  }
  const value = Number(header);
  if (!Number.isFinite(value) || value <= 0) {
    return { status: 411, error: 'Content-Length must be a positive integer' };
  }
  if (value > maxBytes) {
    return { status: 413, error: `request body exceeds ${maxBytes}-byte cap` };
  }
  return null;
}

function readManagedContentType(req: Request): string {
  const ct = req.headers['content-type'];
  if (typeof ct === 'string' && ct.length > 0) return ct;
  return 'application/octet-stream';
}

function parseMetadataHeader(req: Request): ArtifactMetadata {
  const raw = req.headers[METADATA_HEADER];
  if (raw === undefined) return {};
  if (typeof raw !== 'string') {
    throw new InvalidArtifactMetadataError(
      'header X-AtomicMemory-Metadata must be a single header value',
    );
  }
  if (Buffer.byteLength(raw, 'utf8') > METADATA_HEADER_MAX_ENCODED_BYTES) {
    throw new InvalidArtifactMetadataError(
      `header X-AtomicMemory-Metadata exceeds ${METADATA_HEADER_MAX_ENCODED_BYTES}-byte encoded cap`,
    );
  }
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    throw new InvalidArtifactMetadataError('header X-AtomicMemory-Metadata is not valid base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new InvalidArtifactMetadataError(
      'header X-AtomicMemory-Metadata payload is not valid JSON',
    );
  }
  // The inner validator throws plain `invalid_metadata`-shaped errors;
  // rewrap to preserve the header-mode classification.
  try {
    return validateArtifactMetadata(parsed);
  } catch (err) {
    if (err instanceof InvalidArtifactMetadataError) {
      throw new InvalidArtifactMetadataError(`header X-AtomicMemory-Metadata: ${err.reason}`);
    }
    throw err;
  }
}

function readArtifactId(req: Request): string {
  return (req.params as unknown as { id: string }).id;
}

function registerGetArtifactRoute(router: Router, service: StorageService): void {
  router.get('/artifacts/:id', async (req: Request, res: Response) => {
    try {
      const row = await service.getArtifactMetadata(readUserId(req), readArtifactId(req));
      res.json(formatStoredArtifact(row));
    } catch (err) {
      if (handleStorageError(res, err)) return;
      handleRouteError(res, 'GET /v1/storage/artifacts/:id', err);
    }
  });
}

function registerGetArtifactContentRoute(router: Router, service: StorageService): void {
  router.get('/artifacts/:id/content', async (req: Request, res: Response) => {
    try {
      const { row, body } = await service.getArtifactContent(readUserId(req), readArtifactId(req));
      res.setHeader('Content-Type', row.contentType ?? 'application/octet-stream');
      res.setHeader('Content-Length', body.length.toString());
      res.status(200).end(body);
    } catch (err) {
      if (handleStorageError(res, err)) return;
      handleRouteError(res, 'GET /v1/storage/artifacts/:id/content', err);
    }
  });
}

function registerHeadArtifactRoute(router: Router, service: StorageService): void {
  router.head('/artifacts/:id', async (req: Request, res: Response) => {
    try {
      const row = await service.getArtifactMetadata(readUserId(req), readArtifactId(req));
      const headers = formatArtifactHeadHeaders(row);
      res.setHeader('Content-Type', headers.contentType);
      res.setHeader('Content-Length', headers.contentLength.toString());
      res.setHeader('X-AtomicMemory-Artifact-Id', headers.artifactId);
      res.setHeader('X-AtomicMemory-Storage-Mode', headers.storageMode);
      res.setHeader('X-AtomicMemory-Storage-Status', headers.storageStatus);
      res.setHeader('X-AtomicMemory-Provider', headers.provider);
      res.status(200).end();
    } catch (err) {
      if (err instanceof StorageArtifactNotFoundError) {
        res.status(404).end();
        return;
      }
      handleRouteError(res, 'HEAD /v1/storage/artifacts/:id', err);
    }
  });
}

function registerDeleteArtifactRoute(router: Router, service: StorageService): void {
  router.delete('/artifacts/:id', async (req: Request, res: Response) => {
    try {
      if ('force' in req.query) {
        // Any presence of `force` (bare `?force`, `?force=true`,
        // `?force=false`, multi-value) is rejected with a stable
        // typed envelope. Silently coercing to `policy=artifact_only`
        // would mask a caller bug: pre-Step-5 deployments accepted
        // `?force=true` to bypass the reference gate; the new
        // contract requires explicit `policy=with_documents`.
        res.status(400).json({
          error_code: 'force_not_supported',
          error: 'force is not a supported parameter; use policy=with_documents to cascade',
        });
        return;
      }
      const policyRaw = String(req.query.policy ?? 'artifact_only');
      if (policyRaw !== 'artifact_only' && policyRaw !== 'with_documents') {
        res.status(400).json({
          error_code: 'invalid_policy',
          error: "policy must be 'artifact_only' or 'with_documents'",
        });
        return;
      }
      const result = await service.deleteArtifact({
        userId: readUserId(req),
        id: readArtifactId(req),
        policy: policyRaw as 'artifact_only' | 'with_documents',
      });
      res.status(200).json({
        artifact_id: result.artifact.id,
        status: result.artifact.status === 'deleted' ? 'deleted' : 'delete_failed',
        ...(result.cascadedDocumentIds.length > 0
          ? { cascaded_document_ids: result.cascadedDocumentIds }
          : {}),
      });
    } catch (err) {
      if (handleStorageError(res, err)) return;
      handleRouteError(res, 'DELETE /v1/storage/artifacts/:id', err);
    }
  });
}

function registerVerifyArtifactRoute(router: Router, service: StorageService): void {
  router.post('/artifacts/:id/verify', async (req: Request, res: Response) => {
    try {
      const id = readArtifactId(req);
      const result = await service.verifyArtifact(readUserId(req), id);
      res.status(200).json({
        artifact_id: id,
        kind: result.kind,
        ...(result.kind === 'verified'
          ? { details: result.details ?? {} }
          : { reason: result.reason }),
      });
    } catch (err) {
      if (handleStorageError(res, err)) return;
      handleRouteError(res, 'POST /v1/storage/artifacts/:id/verify', err);
    }
  });
}

const USER_ID_HEADER = 'x-atomicmemory-user-id';

/**
 * Owner scope for every direct-storage call comes from the
 * `X-AtomicMemory-User-Id` request header. The legacy `?user_id=`
 * query and body `user_id` field are explicitly rejected — sending
 * identity in URLs leaks into proxy/CDN/error-tracker logs, and
 * body assertion would silently survive a path migration.
 *
 * The `Authorization: Bearer <CORE_API_KEY>` middleware already ran
 * upstream (`requireBearer`); this function only resolves which user
 * the validated caller is acting on behalf of.
 */
function readUserId(req: Request): string {
  if (hasLegacyUserId(req)) {
    throw new LegacyUserIdRejection();
  }
  const fromHeader = req.headers[USER_ID_HEADER];
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;
  throw new InvalidArtifactMetadataError(
    'X-AtomicMemory-User-Id header is required',
  );
}

function hasLegacyUserId(req: Request): boolean {
  if (typeof req.query.user_id === 'string' && req.query.user_id.length > 0) {
    return true;
  }
  if (req.body && typeof req.body === 'object') {
    const candidate = (req.body as Record<string, unknown>).user_id;
    if (typeof candidate === 'string' && candidate.length > 0) return true;
  }
  return false;
}
