/**
 * @file Storage Validation
 *
 * Centralized validation system for storage keys, values, and operations.
 * Provides consistent validation rules across all storage adapters and managers.
 */

import { StorageError } from '../core/error-handling/errors';
import { StorageCapabilities } from './types';

/**
 * Validation configuration for storage operations
 */
export interface ValidationConfig {
  /** Maximum key length in characters */
  maxKeyLength: number;
  /** Maximum value size in bytes */
  maxValueSize: number;
  /** Allowed key patterns (regex) */
  keyPatterns?: RegExp[];
  /** Forbidden key patterns (regex) */
  forbiddenKeyPatterns?: RegExp[];
  /** Custom key validator function */
  customKeyValidator?: (key: string) => boolean;
  /** Custom value validator function */
  customValueValidator?: (value: any) => boolean;
  /** Whether to allow null values */
  allowNullValues?: boolean;
  /** Whether to allow empty strings as values */
  allowEmptyStringValues?: boolean;
}

/**
 * Default validation configuration
 */
export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  maxKeyLength: 1000,
  maxValueSize: 10 * 1024 * 1024, // 10MB
  allowNullValues: true,
  allowEmptyStringValues: true,
  forbiddenKeyPatterns: [
    /^__/, // Reserved prefixes
    /\0/, // Null characters
    /[\r\n\t]/, // Control characters
  ],
};

/**
 * Validation result with detailed information
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

/**
 * Centralized storage validator
 */
export class StorageValidator {
  private config: ValidationConfig;

  constructor(config: Partial<ValidationConfig> = {}) {
    this.config = {
      ...DEFAULT_VALIDATION_CONFIG,
      ...config,
    };
  }

  /**
   * Updates validation configuration
   */
  updateConfig(config: Partial<ValidationConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  /**
   * Gets current validation configuration
   */
  getConfig(): ValidationConfig {
    return { ...this.config };
  }

  /**
   * Validates a storage key
   */
  validateKey(key: string): ValidationResult {
    // Basic type and existence check
    if (!key || typeof key !== 'string') {
      return {
        valid: false,
        error: 'Key must be a non-empty string',
        errorCode: 'INVALID_KEY_TYPE',
        details: { key, type: typeof key },
      };
    }

    // Length check
    if (key.length > this.config.maxKeyLength) {
      return {
        valid: false,
        error: `Key length exceeds maximum of ${this.config.maxKeyLength} characters`,
        errorCode: 'KEY_TOO_LONG',
        details: {
          key,
          length: key.length,
          maxLength: this.config.maxKeyLength,
        },
      };
    }

    // Forbidden patterns check
    if (this.config.forbiddenKeyPatterns) {
      for (const pattern of this.config.forbiddenKeyPatterns) {
        if (pattern.test(key)) {
          return {
            valid: false,
            error: `Key contains forbidden pattern: ${pattern.source}`,
            errorCode: 'FORBIDDEN_KEY_PATTERN',
            details: { key, pattern: pattern.source },
          };
        }
      }
    }

    // Allowed patterns check (if specified)
    if (this.config.keyPatterns && this.config.keyPatterns.length > 0) {
      const matchesPattern = this.config.keyPatterns.some(pattern =>
        pattern.test(key)
      );
      if (!matchesPattern) {
        return {
          valid: false,
          error: 'Key does not match any allowed patterns',
          errorCode: 'KEY_PATTERN_MISMATCH',
          details: {
            key,
            allowedPatterns: this.config.keyPatterns.map(p => p.source),
          },
        };
      }
    }

    // Custom validator check
    if (
      this.config.customKeyValidator &&
      !this.config.customKeyValidator(key)
    ) {
      return {
        valid: false,
        error: 'Key failed custom validation',
        errorCode: 'CUSTOM_KEY_VALIDATION_FAILED',
        details: { key },
      };
    }

    return { valid: true };
  }

  /**
   * Validates a storage value
   */
  validateValue(value: unknown): ValidationResult {
    // Undefined check
    if (value === undefined) {
      return {
        valid: false,
        error: 'Value cannot be undefined',
        errorCode: 'INVALID_VALUE_UNDEFINED',
        details: { value },
      };
    }

    // Null value check
    if (value === null && !this.config.allowNullValues) {
      return {
        valid: false,
        error: 'Null values are not allowed',
        errorCode: 'NULL_VALUE_NOT_ALLOWED',
        details: { value },
      };
    }

    // Empty string check
    if (value === '' && !this.config.allowEmptyStringValues) {
      return {
        valid: false,
        error: 'Empty string values are not allowed',
        errorCode: 'EMPTY_STRING_NOT_ALLOWED',
        details: { value },
      };
    }

    // Size check
    try {
      const serialized = JSON.stringify(value);
      const size = new Blob([serialized]).size;

      if (size > this.config.maxValueSize) {
        return {
          valid: false,
          error: `Value size exceeds maximum of ${this.config.maxValueSize} bytes`,
          errorCode: 'VALUE_TOO_LARGE',
          details: { size, maxSize: this.config.maxValueSize },
        };
      }
    } catch (error) {
      return {
        valid: false,
        error: 'Value cannot be serialized to JSON',
        errorCode: 'VALUE_NOT_SERIALIZABLE',
        details: {
          value,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }

    // Custom validator check
    if (
      this.config.customValueValidator &&
      !this.config.customValueValidator(value)
    ) {
      return {
        valid: false,
        error: 'Value failed custom validation',
        errorCode: 'CUSTOM_VALUE_VALIDATION_FAILED',
        details: { value },
      };
    }

    return { valid: true };
  }

  /**
   * Validates a key-value pair together
   */
  validateKeyValue(key: string, value: unknown): ValidationResult {
    const keyResult = this.validateKey(key);
    if (!keyResult.valid) {
      return keyResult;
    }

    const valueResult = this.validateValue(value);
    if (!valueResult.valid) {
      return valueResult;
    }

    return { valid: true };
  }

  /**
   * Throws StorageError if validation fails
   */
  assertValidKey(key: string, operation: string = 'validate'): void {
    const result = this.validateKey(key);
    if (!result.valid) {
      throw new StorageError(result.error!, result.errorCode!, {
        operation,
        ...result.details,
      });
    }
  }

  /**
   * Throws StorageError if validation fails
   */
  assertValidValue(value: unknown, operation: string = 'validate'): void {
    const result = this.validateValue(value);
    if (!result.valid) {
      throw new StorageError(result.error!, result.errorCode!, {
        operation,
        ...result.details,
      });
    }
  }

  /**
   * Throws StorageError if validation fails
   */
  assertValidKeyValue(
    key: string,
    value: unknown,
    operation: string = 'validate'
  ): void {
    const result = this.validateKeyValue(key, value);
    if (!result.valid) {
      throw new StorageError(result.error!, result.errorCode!, {
        operation,
        ...result.details,
      });
    }
  }

  /**
   * Creates a validator from storage capabilities
   */
  static fromCapabilities(capabilities: StorageCapabilities): StorageValidator {
    return new StorageValidator({
      maxKeyLength: capabilities.maxKeyLength,
      maxValueSize: capabilities.maxValueSize,
    });
  }
}

/**
 * Default global validator instance
 */
const defaultValidator = new StorageValidator();

/**
 * Convenience functions using the default validator
 */
export const validateKey = (key: string): ValidationResult =>
  defaultValidator.validateKey(key);
export const validateValue = (value: unknown): ValidationResult =>
  defaultValidator.validateValue(value);
export const validateKeyValue = (
  key: string,
  value: unknown
): ValidationResult => defaultValidator.validateKeyValue(key, value);
export const assertValidKey = (key: string, operation?: string): void =>
  defaultValidator.assertValidKey(key, operation);
export const assertValidValue = (value: unknown, operation?: string): void =>
  defaultValidator.assertValidValue(value, operation);
export const assertValidKeyValue = (
  key: string,
  value: unknown,
  operation?: string
): void => defaultValidator.assertValidKeyValue(key, value, operation);
