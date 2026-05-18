/**
 * @file Legacy flat re-export of the error-handling module.
 * @deprecated Import from `./error-handling/` directly for better tree-shaking.
 */

// Explicit index path so resolution doesn't loop back to this file.
export * from './error-handling/index';
