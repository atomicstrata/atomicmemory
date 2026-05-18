/**
 * @file Primitive Type Validators
 *
 * Validators for basic JavaScript types: string, number, array, object.
 */

import type { ValidationResult, StringValidationOptions, NumberValidationOptions, ArrayValidationOptions } from './types';

/**
 * Validates a string with comprehensive options
 */
export function validateString(
  value: any,
  options: StringValidationOptions = {}
): ValidationResult {
  if (typeof value !== 'string') {
    return {
      isValid: false,
      error: `Expected string, got ${typeof value}`,
    };
  }

  const {
    minLength = 0,
    maxLength = Infinity,
    pattern,
    allowEmpty = false,
    trim = false,
  } = options;

  let processedValue = trim ? value.trim() : value;

  if (!allowEmpty && processedValue.length === 0) {
    return {
      isValid: false,
      error: 'String cannot be empty',
    };
  }

  if (processedValue.length < minLength) {
    return {
      isValid: false,
      error: `String must be at least ${minLength} characters long`,
    };
  }

  if (processedValue.length > maxLength) {
    return {
      isValid: false,
      error: `String must be at most ${maxLength} characters long`,
    };
  }

  if (pattern && !pattern.test(processedValue)) {
    return {
      isValid: false,
      error: `String does not match required pattern`,
    };
  }

  return { isValid: true };
}

/**
 * Validates a number with comprehensive options
 */
export function validateNumber(
  value: any,
  options: NumberValidationOptions = {}
): ValidationResult {
  if (typeof value !== 'number' || !isFinite(value)) {
    return {
      isValid: false,
      error: `Expected finite number, got ${typeof value}`,
    };
  }

  const { min = -Infinity, max = Infinity, integer = false, positive = false } = options;

  if (integer && !Number.isInteger(value)) {
    return {
      isValid: false,
      error: 'Number must be an integer',
    };
  }

  if (positive && value <= 0) {
    return {
      isValid: false,
      error: 'Number must be positive',
    };
  }

  if (value < min) {
    return {
      isValid: false,
      error: `Number must be at least ${min}`,
    };
  }

  if (value > max) {
    return {
      isValid: false,
      error: `Number must be at most ${max}`,
    };
  }

  return { isValid: true };
}

/**
 * Validates an array with comprehensive options
 */
export function validateArray<T>(
  value: any,
  options: ArrayValidationOptions<T> = {}
): ValidationResult {
  if (!Array.isArray(value)) {
    return {
      isValid: false,
      error: `Expected array, got ${typeof value}`,
    };
  }

  const { minLength = 0, maxLength = Infinity, itemValidator } = options;

  if (value.length < minLength) {
    return {
      isValid: false,
      error: `Array must have at least ${minLength} items`,
    };
  }

  if (value.length > maxLength) {
    return {
      isValid: false,
      error: `Array must have at most ${maxLength} items`,
    };
  }

  if (itemValidator) {
    for (let i = 0; i < value.length; i++) {
      const itemResult = itemValidator(value[i]);
      if (!itemResult.isValid) {
        return {
          isValid: false,
          error: `Item at index ${i}: ${itemResult.error}`,
        };
      }
    }
  }

  return { isValid: true };
}

/**
 * Validates an object with required and optional fields
 */
export function validateObject(
  value: any,
  schema: Record<string, (val: any) => ValidationResult>
): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      isValid: false,
      error: `Expected object, got ${typeof value}`,
    };
  }

  for (const [field, validator] of Object.entries(schema)) {
    if (field in value) {
      const result = validator(value[field]);
      if (!result.isValid) {
        return {
          isValid: false,
          error: `Field '${field}': ${result.error}`,
          field,
        };
      }
    }
  }

  return { isValid: true };
}
