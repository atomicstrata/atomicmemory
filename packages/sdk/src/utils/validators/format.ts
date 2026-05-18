/**
 * @file Format Validators
 *
 * Validators for common data formats: URL, email, UUID.
 */

import type { ValidationResult } from './types';
import { validateString } from './primitive';

/**
 * Validates a URL string
 */
export function validateUrl(value: any): ValidationResult {
  const stringResult = validateString(value, { minLength: 1 });
  if (!stringResult.isValid) {
    return stringResult;
  }

  try {
    new URL(value);
    return { isValid: true };
  } catch {
    return {
      isValid: false,
      error: 'Invalid URL format',
    };
  }
}

/**
 * Validates an email address
 */
export function validateEmail(value: any): ValidationResult {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return validateString(value, {
    minLength: 1,
    maxLength: 254,
    pattern: emailPattern,
  });
}

/**
 * Validates a UUID string
 */
export function validateUuid(value: any): ValidationResult {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return validateString(value, {
    minLength: 36,
    maxLength: 36,
    pattern: uuidPattern,
  });
}
