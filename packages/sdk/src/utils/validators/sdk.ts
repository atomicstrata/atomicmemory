/**
 * @file SDK-Specific Validators
 *
 * Validators for AtomicMemory SDK-specific data types and parameters.
 */

import type { ValidationResult } from './types';
import { validateString, validateNumber, validateArray } from './primitive';

/**
 * Validates a context ID
 */
export function validateContextId(contextId: any): ValidationResult {
  return validateString(contextId, {
    minLength: 1,
    maxLength: 100,
    trim: true,
  });
}

/**
 * Validates a user ID
 */
export function validateUserId(userId: any): ValidationResult {
  return validateString(userId, {
    minLength: 1,
    maxLength: 100,
    trim: true,
  });
}

/**
 * Validates content text
 */
export function validateContent(content: any): ValidationResult {
  return validateString(content, {
    minLength: 1,
    maxLength: 100000, // 100KB max
    trim: true,
  });
}

/**
 * Validates a search query
 */
export function validateSearchQuery(query: any): ValidationResult {
  return validateString(query, {
    minLength: 1,
    maxLength: 1000,
    trim: true,
  });
}

/**
 * Validates an embedding vector
 */
export function validateEmbedding(embedding: any): ValidationResult {
  const arrayResult = validateArray(embedding, {
    minLength: 1,
    maxLength: 10000,
    itemValidator: (item) => validateNumber(item, { min: -1, max: 1 }),
  });

  if (!arrayResult.isValid) {
    return arrayResult;
  }

  // Check if all values are finite numbers
  if (!embedding.every((val: any) => typeof val === 'number' && isFinite(val))) {
    return {
      isValid: false,
      error: 'All embedding values must be finite numbers',
    };
  }

  return { isValid: true };
}

/**
 * Validates similarity score
 */
export function validateSimilarityScore(score: any): ValidationResult {
  return validateNumber(score, {
    min: -1,
    max: 1,
  });
}

/**
 * Validates chunk options
 */
export function validateChunkOptions(options: any): ValidationResult {
  if (typeof options !== 'object' || options === null) {
    return {
      isValid: false,
      error: 'Chunk options must be an object',
    };
  }

  const { chunkSize, chunkOverlap } = options;

  const chunkSizeResult = validateNumber(chunkSize, {
    min: 1,
    max: 100000,
    integer: true,
    positive: true,
  });
  if (!chunkSizeResult.isValid) {
    return {
      isValid: false,
      error: `chunkSize: ${chunkSizeResult.error}`,
      field: 'chunkSize',
    };
  }

  const chunkOverlapResult = validateNumber(chunkOverlap, {
    min: 0,
    max: chunkSize - 1,
    integer: true,
  });
  if (!chunkOverlapResult.isValid) {
    return {
      isValid: false,
      error: `chunkOverlap: ${chunkOverlapResult.error}`,
      field: 'chunkOverlap',
    };
  }

  return { isValid: true };
}

/**
 * Validates search options
 */
export function validateSearchOptions(options: any): ValidationResult {
  if (typeof options !== 'object' || options === null) {
    return { isValid: true }; // Options are optional
  }

  const validations: Array<[string, any, (val: any) => ValidationResult]> = [
    ['topK', options.topK, (val) => validateNumber(val, { min: 1, max: 1000, integer: true })],
    ['threshold', options.threshold, (val) => validateNumber(val, { min: 0, max: 1 })],
    ['maxResults', options.maxResults, (val) => validateNumber(val, { min: 1, max: 10000, integer: true })],
  ];

  for (const [field, value, validator] of validations) {
    if (value !== undefined) {
      const result = validator(value);
      if (!result.isValid) {
        return {
          isValid: false,
          error: `${field}: ${result.error}`,
          field,
        };
      }
    }
  }

  return { isValid: true };
}
