/**
 * /v1/documents — multi-phase document pipeline router.
 *
 * Routes the document registry + lifecycle surface, layered up through
 * the rev-18 hardening plan:
 *   - Phase 1: pointer-only registration, get-by-id, legacy
 *     `/list` (offset/limit + source_site), soft-delete.
 *   - Phase 2: `POST /:id/index` chunks + embeds supplied text.
 *   - Phase 3: `PUT /:id/raw` managed-blob upload (when
 *     `RAW_STORAGE_MODE=managed_blob` is configured); the post-upload
 *     row promotion sets `storage_mode='managed_blob'` and
 *     `raw_storage_status='blob_stored'`.
 *   - Phase B/C: per-layer status + `last_error` envelope + the
 *     constrained-transition routes
 *     `POST /:id/extraction-failure` and `POST /:id/index-failure`.
 *   - Phase D: cursor-paginated `GET /` (root list),
 *     `GET /without-memories` (recovery-status filter), and
 *     `GET /passport-feed` (data-layer grouped feed) on top of
 *     `GET /limits` for the runtime preflight surface.
 *
 * Validation + response-shape conventions match `/v1/memories`
 * (`createMemoryRouter`, `validateBody`, `validateResponse`).
 *
 * `POST /v1/documents` (register) still only accepts
 * `storage_mode='pointer_only'` on the wire — the `managed_blob` /
 * `inline_small_text` modes are populated by `PUT /:id/raw` (and a
 * future inline-text path) rather than declared at register time.
 *
 * See `the large-file ingestion design notes`
 * and the rev-18 hardening plan.
 */

import express, { Router, type Request, type Response } from 'express';
import { handleRouteError } from './route-errors.js';
import { validateBody, validateQuery, validateParams } from '../middleware/validate.js';
import { validateResponse } from '../middleware/validate-response.js';
import { DOCUMENT_RESPONSE_SCHEMAS } from './response-schema-map.js';
import {
  DocumentByIdQuerySchema,
  DocumentIdParamSchema,
  ExtractionFailureBodySchema,
  IndexDocumentBodySchema,
  IndexFailureBodySchema,
  INDEX_BODY_PARSER_LIMIT,
  ListDocumentsQuerySchema,
  RegisterDocumentBodySchema,
  UploadRawDocumentQuerySchema,
  type ExtractionFailureBody,
  type IndexDocumentBody,
  type IndexFailureBody,
  type RegisterDocumentBody,
  type UploadRawDocumentQuery,
} from '../schemas/documents.js';
import {
  DocumentListRootQuerySchema,
  ListDocumentsWithoutMemoriesQuerySchema,
  PassportFeedQuerySchema,
  type DocumentListRootQuery,
  type ListDocumentsWithoutMemoriesQuery,
  type PassportFeedQuery,
} from '../schemas/document-list-schemas.js';
import {
  formatDeleteDocumentResponse,
  formatDocumentFailureMarkerResponse,
  formatDocumentLimitsResponse,
  formatDocumentListRootResponse,
  formatPassportFeedResponse,
  formatIndexDocumentResponse,
  formatListDocumentsResponse,
  formatRawDocument,
  formatRegisterDocumentResponse,
  formatUploadRawDocumentResponse,
  type DocumentLimitsSnapshot,
} from './document-response-formatters.js';
import {
  DocumentNotFoundError,
  IndexInputError,
  IndexInvalidStateError,
  IndexSemanticValidationError,
} from '../services/document-indexer.js';
import { InvalidDocumentListCursorError } from '../services/document-service.js';
import {
  ManagedStorageDisabledError,
  UploadDocumentConflictError,
  UploadDocumentNotFoundError,
} from '../services/document-upload.js';
import { ArtifactNotLinkableError } from '../db/storage-artifact-repository.js';
import {
  ExtractionFailureInvalidStateError,
  FailureMarkerDocumentNotFoundError,
  IndexFailureInvalidStateError,
} from '../services/document-failure-markers.js';
import type { DocumentService } from '../services/document-service.js';

/** Router-level JSON-body cap for register / delete / limits / etc. */
const ROUTER_JSON_BODY_LIMIT = '1mb';

/**
 * Shared catch-handler for the three cursor-paginated Phase D list
 * routes. Each one wraps the same `InvalidDocumentListCursorError ->
 * 400 invalid_cursor` mapping and otherwise delegates to the
 * generic route-error handler; centralising the mapping keeps the
 * three route bodies behaviorally identical without duplicating the
 * narrow catch ladder at every call site.
 */
function handleDocumentListRouteError(res: Response, label: string, err: unknown): void {
  if (err instanceof InvalidDocumentListCursorError) {
    res.status(400).json({ error: 'invalid_cursor', message: err.message });
    return;
  }
  handleRouteError(res, label, err);
}

/**
 * Pull `(id, userId)` from a `/:id` route request. Both fields are
 * already validated by `validateParams(DocumentIdParamSchema)` +
 * `validateQuery(DocumentByIdQuerySchema)`; the casts here are the
 * narrow projection both `GET /:id` and `DELETE /:id` perform.
 */
function parseDocumentIdRequest(req: Request): { id: string; userId: string } {
  const { id } = req.params as unknown as { id: string };
  const { userId } = req.query as unknown as { userId: string };
  return { id, userId };
}

/**
 * Project a failure-marker request body into the {@link MarkerInput}
 * shape consumed by `DocumentService.markExtractionFailure` and
 * `markIndexFailure`. The two routes are intentionally parallel:
 * each owns its own error-code enum and per-layer state errors, but
 * the body-to-args mapping is identical.
 */
function buildMarkerInput<C extends string>(
  id: string,
  body: { userId: string; errorCode: C; errorMessage: string },
): { userId: string; documentId: string; errorCode: C; errorMessage: string } {
  return {
    userId: body.userId,
    documentId: id,
    errorCode: body.errorCode,
    errorMessage: body.errorMessage,
  };
}

/** Composition-time options for {@link createDocumentRouter}. */
export interface DocumentRouterOptions {
  /**
   * Body-size cap (bytes) for `PUT /v1/documents/:id/raw`. Required so
   * the limit is wired explicitly at composition time — this module
   * intentionally does not read `config.rawUploadMaxBytes`, keeping the
   * route layer free of singleton imports.
   */
  rawUploadMaxBytes: number;
  /**
   * Public preflight snapshot for `GET /v1/documents/limits`. Surfaces
   * byte caps and raw-storage capability so clients can size requests
   * and decide whether to attempt a managed-blob upload before
   * touching the database. Sourced from the runtime config at
   * composition time; the route layer does not import config singletons.
   */
  limits: DocumentLimitsSnapshot;
}

/**
 * Build the documents router with composition-owned limits.
 *
 * Body-parser ordering inside this router (deliberate — see
 * `the document ingest audit notes`
 * and the rev-18 hardening plan):
 *   1. validate-response (response-shape contract).
 *   2. Query-only GETs first (`/limits`, `/list`) so they can never be
 *      shadowed by `/:id` and never need a body parser.
 *   3. Per-route large parsers (`POST /:id/index` → 25 MiB JSON,
 *      `PUT /:id/raw` → raw bytes), registered BEFORE the router-level
 *      JSON middleware so the larger cap wins for that single path.
 *   4. Router-level `express.json({ limit: '1mb' })` fallthrough for the
 *      remaining JSON-body routes.
 *   5. Remaining JSON-body routes (`POST /`, `DELETE /:id`).
 *   6. `GET /:id` LAST so it cannot shadow `/limits`, `/list`, etc.
 *
 * The router takes ownership of body parsing — `create-app.ts` mounts
 * the documents router WITHOUT an upstream `express.json` so the
 * larger `/index` parser is not silently overridden.
 */
export function createDocumentRouter(
  service: DocumentService,
  options: DocumentRouterOptions,
): Router {
  const router = Router();
  router.use(validateResponse(DOCUMENT_RESPONSE_SCHEMAS));

  // Step 2 — query-only GETs first.
  registerLimitsRoute(router, options.limits);
  registerListRoute(router, service);
  registerListRootRoute(router, service);
  registerWithoutMemoriesRoute(router, service);
  registerPassportFeedRoute(router, service);

  // Step 3 — per-route body parsers.
  registerIndexRoute(router, service);
  registerUploadRoute(router, service, options.rawUploadMaxBytes);

  // Step 4 — router-level JSON parser for the remaining JSON-body routes.
  router.use(express.json({ limit: ROUTER_JSON_BODY_LIMIT }));

  // Step 5 — JSON-body routes. The Phase C failure-marker routes
  // (`/:id/extraction-failure`, `/:id/index-failure`) live with the
  // other 1 MiB-bounded JSON-body routes — small constrained-
  // transition payloads, not raw text.
  registerRegisterRoute(router, service);
  registerExtractionFailureRoute(router, service);
  registerIndexFailureRoute(router, service);
  registerDeleteRoute(router, service);

  // Step 6 — `GET /:id` registered LAST so it never shadows the
  // query-only GETs above.
  registerGetRoute(router, service);
  return router;
}

function registerLimitsRoute(router: Router, limits: DocumentLimitsSnapshot): void {
  // Public, non-PII preflight surface — clients call this to read
  // byte caps and raw-storage capability before attempting an upload.
  // Auth posture: intentionally public (mirrors `/health`); no
  // per-user state.
  router.get('/limits', (_req: Request, res: Response) => {
    res.json(formatDocumentLimitsResponse(limits));
  });
}

function registerRegisterRoute(router: Router, service: DocumentService): void {
  router.post('/', validateBody(RegisterDocumentBodySchema), async (req: Request, res: Response) => {
    try {
      const body = req.body as RegisterDocumentBody;
      const result = await service.register(body);
      // Idempotent re-register returns 200 with the existing row;
      // a fresh insert returns 201.
      res.status(result.created ? 201 : 200).json(formatRegisterDocumentResponse(result, service.getStoreRegistry()));
    } catch (err) {
      handleRouteError(res, 'POST /v1/documents', err);
    }
  });
}

function registerListRoute(router: Router, service: DocumentService): void {
  router.get('/list', validateQuery(ListDocumentsQuerySchema), async (req: Request, res: Response) => {
    try {
      const q = req.query as unknown as {
        userId: string;
        sourceSite: string | undefined;
        limit: number;
        offset: number;
      };
      const documents = await service.list({
        userId: q.userId,
        sourceSite: q.sourceSite,
        limit: q.limit,
        offset: q.offset,
      });
      res.json(formatListDocumentsResponse(documents, service.getStoreRegistry()));
    } catch (err) {
      handleRouteError(res, 'GET /v1/documents/list', err);
    }
  });
}

/**
 * Phase D — `GET /v1/documents`. Cursor-paginated, status-bucket
 * filtered. Registered alongside `/list`, before `/:id`, so it does
 * not conflict with the legacy offset/limit list endpoint and so
 * `:id` cannot shadow the root list.
 */
function registerListRootRoute(router: Router, service: DocumentService): void {
  router.get('/', validateQuery(DocumentListRootQuerySchema), async (req: Request, res: Response) => {
    try {
      const q = req.query as unknown as DocumentListRootQuery;
      const result = await service.listForUser(q);
      res.json(formatDocumentListRootResponse(result, service.getStoreRegistry()));
    } catch (err) {
      handleDocumentListRouteError(res, 'GET /v1/documents', err);
    }
  });
}

/**
 * Phase D — `GET /v1/documents/passport-feed`. Memory-backed feed:
 * one row per documentId-with-memories (grouped + status-enveloped)
 * plus 1:1 standalone-memory rows, ordered by
 * `(sort_at DESC, sort_id DESC)`. The webapp's
 * `/api/context/passport` consumes this as the memory-feed stream
 * of its server-side two-stream merge. Registered BEFORE `/:id`.
 */
function registerPassportFeedRoute(router: Router, service: DocumentService): void {
  router.get(
    '/passport-feed',
    validateQuery(PassportFeedQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const q = req.query as unknown as PassportFeedQuery;
        const result = await service.listPassportFeed(q);
        res.json(formatPassportFeedResponse(result, service.getStoreRegistry()));
      } catch (err) {
        handleDocumentListRouteError(res, 'GET /v1/documents/passport-feed', err);
      }
    },
  );
}

/**
 * Phase D — `GET /v1/documents/without-memories`. Layer-aware
 * recovery filter; backs the passport server-side merge document-only
 * stream and any UI surface that wants to show "uploaded but no
 * indexed content yet" rows. Registered BEFORE `/:id` so the literal
 * path can never be matched as a UUID.
 */
function registerWithoutMemoriesRoute(router: Router, service: DocumentService): void {
  router.get(
    '/without-memories',
    validateQuery(ListDocumentsWithoutMemoriesQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const q = req.query as unknown as ListDocumentsWithoutMemoriesQuery;
        const result = await service.listWithoutMemoriesForUser(q);
        res.json(formatDocumentListRootResponse(result, service.getStoreRegistry()));
      } catch (err) {
        handleDocumentListRouteError(res, 'GET /v1/documents/without-memories', err);
      }
    },
  );
}

function registerGetRoute(router: Router, service: DocumentService): void {
  router.get(
    '/:id',
    validateParams(DocumentIdParamSchema),
    validateQuery(DocumentByIdQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { id, userId } = parseDocumentIdRequest(req);
        const document = await service.get(userId, id);
        if (!document) {
          res.status(404).json({ error: 'Document not found' });
          return;
        }
        res.json(formatRawDocument(document, service.getStoreRegistry()));
      } catch (err) {
        handleRouteError(res, 'GET /v1/documents/:id', err);
      }
    },
  );
}

function registerIndexRoute(router: Router, service: DocumentService): void {
  // Per-route JSON parser sized to `INDEX_BODY_PARSER_LIMIT`
  // (`MAX_INDEX_TEXT_BYTES` plus a 64 KiB headroom for the JSON
  // wrapper + escape encoding). Registered BEFORE the router-level
  // 1 MiB JSON parser (in `createDocumentRouter`), so the larger cap
  // wins for this one path. Express's body-parser is a no-op when
  // `req.body` is already populated; pairing the larger parser
  // earlier in the chain ensures it owns the body for `/:id/index`.
  //
  // Phase B durable-failure contract: the parser deliberately
  // ADMITS bodies whose `text` field is over `MAX_INDEX_TEXT_BYTES`
  // (up to the 64 KiB headroom) so the indexer's `semanticValidate`
  // can run and mark `semantic_index_status='failed'` +
  // `last_error.code='index_text_too_large'` BEFORE the route
  // returns 413. The cap-sized happy-path body
  // (`text` exactly `MAX_INDEX_TEXT_BYTES`) reaches the handler and
  // succeeds; any text over the cap fails durably; bodies far above
  // the headroom still get rejected by the parser as truly
  // oversized payloads. The Zod schema does NOT pre-empt with a
  // refine - see `IndexDocumentBodySchema` in
  // `src/schemas/documents.ts`.
  const indexJsonParser = express.json({ limit: INDEX_BODY_PARSER_LIMIT });
  router.post(
    '/:id/index',
    indexJsonParser,
    validateParams(DocumentIdParamSchema),
    validateBody(IndexDocumentBodySchema),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params as unknown as { id: string };
        const body = req.body as IndexDocumentBody;
        const result = await service.indexText({
          documentId: id,
          userId: body.userId,
          text: body.text,
        });
        res.json(formatIndexDocumentResponse(result));
      } catch (err) {
        if (err instanceof DocumentNotFoundError) {
          res.status(404).json({ error: 'Document not found' });
          return;
        }
        if (err instanceof IndexInputError) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err instanceof IndexInvalidStateError) {
          // Phase B — concurrent writer / `not_required` row. The
          // catch path inside the indexer deliberately did NOT mark
          // the row failed for this case (it would clobber another
          // writer's state); we surface 409 with the current status
          // so the caller can decide whether to retry.
          res.status(409).json({
            error: 'Invalid index state transition',
            current: err.currentStatus,
            documentId: err.documentId,
          });
          return;
        }
        if (err instanceof IndexSemanticValidationError) {
          // Phase B — known-document semantic failure (text too
          // large / empty). The indexer wrote durable
          // `semantic_index_status='failed'` + `last_error.code`
          // before this catch ran, so the row is recoverable via
          // `GET /api/context/documents/:id`. Echo the documentId
          // in the body so callers can navigate to it.
          const status = err.code === 'index_text_too_large' ? 413 : 400;
          res.status(status).json({
            error: err.message,
            code: err.code,
            documentId: err.documentId,
          });
          return;
        }
        handleRouteError(res, 'POST /v1/documents/:id/index', err);
      }
    },
  );
}

function registerUploadRoute(
  router: Router,
  service: DocumentService,
  rawUploadMaxBytes: number,
): void {
  // Mount the raw-body parser ONLY on this route. The global JSON
  // parser stays unaffected. `type: '*/*'` accepts any content-type
  // (callers may send application/octet-stream, application/pdf, etc.);
  // the limit is supplied by the composition root, so the route layer
  // does not import the config singleton.
  const rawParser = express.raw({ type: '*/*', limit: rawUploadMaxBytes });
  router.put(
    '/:id/raw',
    rawParser,
    validateParams(DocumentIdParamSchema),
    validateQuery(UploadRawDocumentQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params as unknown as { id: string };
        const q = req.query as unknown as UploadRawDocumentQuery;
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: 'request body is required' });
          return;
        }
        const result = await service.uploadRaw({
          documentId: id,
          userId: q.userId,
          body,
          contentType: q.contentType,
        });
        res.json(formatUploadRawDocumentResponse(result, service.getStoreRegistry()));
      } catch (err) {
        if (err instanceof UploadDocumentNotFoundError) {
          res.status(404).json({ error: 'Document not found' });
          return;
        }
        if (err instanceof UploadDocumentConflictError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof ArtifactNotLinkableError) {
          // The doc's prior artifact entered a delete lifecycle
          // between our upload claim and the swap; the bytes have
          // already been compensated (see `compensateOrphanedBlob`
          // in `document-upload.ts`). Surface as 409 so the
          // caller retries after the in-flight delete settles.
          res.status(409).json({
            error_code: 'artifact_not_linkable',
            error: err.message,
            artifact_id: err.artifactId,
            artifact_status: err.status,
          });
          return;
        }
        if (err instanceof ManagedStorageDisabledError) {
          res.status(503).json({ error: err.message });
          return;
        }
        handleRouteError(res, 'PUT /v1/documents/:id/raw', err);
      }
    },
  );
}

function registerExtractionFailureRoute(router: Router, service: DocumentService): void {
  router.post(
    '/:id/extraction-failure',
    validateParams(DocumentIdParamSchema),
    validateBody(ExtractionFailureBodySchema),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params as unknown as { id: string };
        const body = req.body as ExtractionFailureBody;
        const result = await service.markExtractionFailure(buildMarkerInput(id, body));
        res.json(formatDocumentFailureMarkerResponse(result, service.getStoreRegistry()));
      } catch (err) {
        if (err instanceof FailureMarkerDocumentNotFoundError) {
          res.status(404).json({ error: 'Document not found' });
          return;
        }
        if (err instanceof ExtractionFailureInvalidStateError) {
          // Phase C - 409 echoes the row's current per-layer state so
          // the caller can decide whether to retry, reset, or
          // surface the conflict to a human.
          res.status(409).json({
            error: 'Invalid extraction state transition',
            documentId: err.documentId,
            current: err.current,
          });
          return;
        }
        handleRouteError(res, 'POST /v1/documents/:id/extraction-failure', err);
      }
    },
  );
}

function registerIndexFailureRoute(router: Router, service: DocumentService): void {
  router.post(
    '/:id/index-failure',
    validateParams(DocumentIdParamSchema),
    validateBody(IndexFailureBodySchema),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params as unknown as { id: string };
        const body = req.body as IndexFailureBody;
        const result = await service.markIndexFailure(buildMarkerInput(id, body));
        res.json(formatDocumentFailureMarkerResponse(result, service.getStoreRegistry()));
      } catch (err) {
        if (err instanceof FailureMarkerDocumentNotFoundError) {
          res.status(404).json({ error: 'Document not found' });
          return;
        }
        if (err instanceof IndexFailureInvalidStateError) {
          res.status(409).json({
            error: 'Invalid index state transition',
            documentId: err.documentId,
            current: err.current,
          });
          return;
        }
        handleRouteError(res, 'POST /v1/documents/:id/index-failure', err);
      }
    },
  );
}

function registerDeleteRoute(router: Router, service: DocumentService): void {
  router.delete(
    '/:id',
    validateParams(DocumentIdParamSchema),
    validateQuery(DocumentByIdQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { id, userId } = parseDocumentIdRequest(req);
        const result = await service.delete(userId, id);
        res.json(formatDeleteDocumentResponse(result));
      } catch (err) {
        handleRouteError(res, 'DELETE /v1/documents/:id', err);
      }
    },
  );
}
