/**
 * Shared scalar schemas for HTTP response validation.
 *
 * These preprocessors match Express serialization behavior so the development
 * response validator can run before `JSON.stringify` converts values.
 */

import { z } from './zod-setup.js';

export const IsoDateString = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string(),
);

export const IsoDateStringOrNull = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string().nullable(),
);

export const NumberOrNaN = z.preprocess(
  (value) => (typeof value === 'number' && Number.isNaN(value) ? null : value),
  z.number().nullable(),
);
