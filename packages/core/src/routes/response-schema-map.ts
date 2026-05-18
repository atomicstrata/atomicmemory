/**
 * @file Route→schema maps consumed by `validate-response` middleware.
 *
 * Keyed by Express's router-relative `${method} ${route.path}` format
 * (method lowercase, path matches what Express stores in `req.route.path`).
 * When a new route is added, add a corresponding entry here; the
 * validator is a no-op for routes not in the map (so new routes
 * ship without a hard dependency on a schema existing yet).
 */

import * as R from '../schemas/responses.js';
import { PassportFeedResponseSchema } from '../schemas/document-list-responses.js';
import {
  DeleteArtifactResultSchema,
  StorageCapabilitiesResponseSchema,
  StoredArtifactResponseSchema,
  VerifyArtifactResultSchema,
} from '../schemas/storage-schemas.js';
import type { ResponseSchemaMap } from '../middleware/validate-response.js';

export const MEMORY_RESPONSE_SCHEMAS: ResponseSchemaMap = {
  'post /ingest': R.IngestResponseSchema,
  'post /ingest/quick': R.IngestResponseSchema,
  'post /search': R.SearchResponseSchema,
  'post /search/fast': R.SearchResponseSchema,
  'post /expand': R.ExpandResponseSchema,
  'post /verify': R.VerifyResponseSchema,
  'get /list': R.ListResponseSchema,
  'get /stats': R.StatsResponseSchema,
  'get /health': R.HealthResponseSchema,
  'put /config': R.ConfigUpdateResponseSchema,
  'get /event-chains': R.EventChainsResponseSchema,
  'post /first-mentions/extract': R.FirstMentionsExtractResponseSchema,
  'post /consolidate': R.ConsolidateResponseSchema,
  'post /decay': R.DecayResponseSchema,
  'get /cap': R.CapResponseSchema,
  'get /lessons': R.LessonsListResponseSchema,
  'get /lessons/stats': R.LessonStatsResponseSchema,
  'post /lessons/report': R.LessonReportResponseSchema,
  'delete /lessons/:id': R.SuccessResponseSchema,
  'post /reconcile': R.ReconciliationResponseSchema,
  'get /reconcile/status': R.ReconcileStatusResponseSchema,
  'post /reset-source': R.ResetSourceResponseSchema,
  'get /:id': R.GetMemoryResponseSchema,
  'delete /:id': R.SuccessResponseSchema,
  'get /audit/summary': R.MutationSummaryResponseSchema,
  'get /audit/recent': R.AuditRecentResponseSchema,
  'get /:id/audit': R.AuditTrailResponseSchema,
};

export const AGENT_RESPONSE_SCHEMAS: ResponseSchemaMap = {
  'put /trust': R.TrustResponseSchema,
  'get /trust': R.TrustResponseSchema,
  'get /conflicts': R.ConflictsListResponseSchema,
  'put /conflicts/:id/resolve': R.ResolveConflictResponseSchema,
  'post /conflicts/auto-resolve': R.AutoResolveConflictsResponseSchema,
};

export const DOCUMENT_RESPONSE_SCHEMAS: ResponseSchemaMap = {
  'post /': R.RegisterDocumentResponseSchema,
  'get /': R.DocumentListRootResponseSchema,
  'get /limits': R.DocumentLimitsResponseSchema,
  'get /list': R.ListDocumentsResponseSchema,
  'get /without-memories': R.DocumentListRootResponseSchema,
  'get /passport-feed': PassportFeedResponseSchema,
  'post /:id/index': R.IndexDocumentResponseSchema,
  'post /:id/extraction-failure': R.DocumentFailureMarkerResponseSchema,
  'post /:id/index-failure': R.DocumentFailureMarkerResponseSchema,
  'put /:id/raw': R.UploadRawDocumentResponseSchema,
  'get /:id': R.RawDocumentResponseSchema,
  'delete /:id': R.DeleteDocumentResponseSchema,
};

export const STORAGE_RESPONSE_SCHEMAS: ResponseSchemaMap = {
  'get /capabilities': StorageCapabilitiesResponseSchema,
  'post /artifacts': StoredArtifactResponseSchema,
  'get /artifacts/:id': StoredArtifactResponseSchema,
  'delete /artifacts/:id': DeleteArtifactResultSchema,
  'post /artifacts/:id/verify': VerifyArtifactResultSchema,
};
