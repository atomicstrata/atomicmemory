/**
 * @file `rejectNulInRequestTarget` / `rejectNulInBody` — boundary guards that
 * reject NUL bytes (U+0000) in user-controlled strings before they reach
 * Postgres, which cannot store `\x00` in `text`/`varchar`/`jsonb` and raises —
 * turning documented client input into a 500 instead of a validated 400.
 *
 * Why a boundary guard and not per-field schema refines: the user_id / source /
 * identifier surface is wide (multiple query schemas, raw `z.string()` body
 * fields, path params) and grows; refining each field is leaky by construction
 * (see QA release-1.1.0 `core-robustness:nul.*` and the follow-up review). A
 * guard at the request boundary closes the whole class, including future fields.
 * The shared `scanForNul` walker inspects object **keys** as well as values, so
 * a NUL smuggled in as a JSON property name (which reaches a JSONB column, or a
 * `config_override` key that flows into `res.setHeader`) is rejected too. The
 * pg query-layer backstop (`db/nul-guard.ts`) is the deepest net; the schema
 * refines in `schemas/common.ts` remain for precise per-field 400 messages.
 *
 * **Binary safety:** `rejectNulInRequestTarget` only inspects the query string
 * and the request-target (never binary), so it is mounted globally.
 * `rejectNulInBody` inspects `req.body` and is mounted **only** on the
 * JSON-parsed routers — never on `/v1/storage` managed uploads or document raw
 * bodies, where the payload is binary and a NUL byte is legitimate. As an extra
 * guard, `scanForNul` skips `Buffer` values, so an accidental mount over a raw
 * body is a no-op rather than a corruption.
 *
 * **Denial-of-service safety:** `scanForNul` walks iteratively with an explicit
 * stack and a depth bound, so a crafted deeply-nested body cannot exhaust the
 * call stack; past the bound the request is rejected with a 400.
 *
 * Wire envelope matches `middleware/validate.ts`: `400 { error: string }`.
 */

import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { scanForNul, type NulScanResult } from '../nul-scan.js';

/**
 * Percent-encoded NUL in a request target. `%00` only ever decodes to a NUL
 * byte, so its presence is unambiguously malformed. Caught on `originalUrl`
 * because path params are not yet decoded into `req.params` at mount time.
 */
const ENCODED_NUL = '%00';

/** Map a non-clean scan result to its 400 envelope; returns true when sent. */
function rejectScan(res: Response, where: string, result: NulScanResult): boolean {
  if (result === 'nul') {
    res.status(400).json({ error: `${where} must not contain NUL bytes` });
    return true;
  }
  if (result === 'too-deep') {
    res.status(400).json({ error: `${where} is too deeply nested` });
    return true;
  }
  return false;
}

/**
 * Reject a NUL byte in the query string or path. Safe to mount globally: the
 * query string and request target are never binary.
 */
export const rejectNulInRequestTarget: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (req.originalUrl.includes(ENCODED_NUL)) {
    res.status(400).json({ error: 'request must not contain NUL bytes' });
    return;
  }
  if (rejectScan(res, 'request', scanForNul(req.query))) return;
  next();
};

/**
 * Reject a NUL byte in the parsed JSON body. Mount AFTER the router's
 * `express.json` parser and ONLY on JSON routers (never on binary/raw bodies).
 */
export const rejectNulInBody: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (rejectScan(res, 'request body', scanForNul(req.body))) return;
  next();
};
