/**
 * @file Canonical CORS `Access-Control-Allow-Headers` list shared by
 * the global CORS middleware (`createApp`) and any router-scoped
 * CORS shims (`routes/memories.ts`). Keeping the list in one place
 * stops a router-level overwrite from silently regressing the
 * preflight contract for the headers the SDK / webapp-sdk send.
 *
 * `Content-Length` is CORS-safelisted by the browser; it does not
 * need to appear here.
 */

/** Single comma-joined string for `Access-Control-Allow-Headers`. */
export const CORS_ALLOWED_HEADERS_VALUE: string = [
  'Content-Type',
  'Authorization',
  'X-AtomicMemory-User-Id',
  'X-AtomicMemory-Metadata',
  'X-AtomicMemory-Content-Encoding',
].join(', ');
