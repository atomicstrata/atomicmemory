/**
 * @file Validation Types and Interfaces
 *
 * Core types and interfaces used throughout the validation system.
 */

/**
 * Validation result interface
 */
export interface ValidationResult {
  isValid: boolean;
  error?: string;
  field?: string;
}

/**
 * Validation error class
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
    public value?: any
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * String validation options
 */
export interface StringValidationOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  allowEmpty?: boolean;
  trim?: boolean;
}

/**
 * Number validation options
 */
export interface NumberValidationOptions {
  min?: number;
  max?: number;
  integer?: boolean;
  positive?: boolean;
}

/**
 * Array validation options
 */
export interface ArrayValidationOptions<T> {
  minLength?: number;
  maxLength?: number;
  itemValidator?: (item: T) => ValidationResult;
}
