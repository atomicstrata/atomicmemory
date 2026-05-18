/**
 * @file Assertion Utilities
 *
 * Convenience functions for throwing validation errors and creating throwing validators.
 */

import type { ValidationResult } from './types';
import { ValidationError } from './types';

/**
 * Validates and throws if invalid
 */
export function assertValid(
  value: any,
  validator: (val: any) => ValidationResult,
  fieldName?: string
): void {
  const result = validator(value);
  if (!result.isValid) {
    throw new ValidationError(result.error!, fieldName || result.field, value);
  }
}

/**
 * Creates a validator that throws on invalid input
 */
export function createThrowingValidator<T>(
  validator: (val: any) => ValidationResult
): (val: any) => T {
  return (value: any): T => {
    assertValid(value, validator);
    return value as T;
  };
}
