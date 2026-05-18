/**
 * @file Environment Detection Utilities
 *
 * Provides browser-safe, cross-platform environment detection for the AtomicMemory SDK.
 * These utilities work correctly across Node.js, web browsers, service workers,
 * and browser extension contexts.
 *
 * ## Design Principles
 *
 * 1. **No Direct process.env Access** - Uses RuntimeConfig singleton for environment values
 * 2. **Browser Safety** - All functions work without Node.js globals
 * 3. **Extension Compatibility** - Handles service worker and content script contexts
 *
 * ## Runtime Contexts
 *
 * | Context | Detection Method |
 * |---------|------------------|
 * | Node.js | `typeof process !== 'undefined'` |
 * | Browser (window) | `typeof window !== 'undefined'` |
 * | Service Worker | `typeof self !== 'undefined' && typeof importScripts === 'function'` |
 * | Web Worker | `typeof WorkerGlobalScope !== 'undefined'` |
 *
 * ## Environment Values
 *
 * Environment is determined from RuntimeConfig which loads from:
 * - `NODE_ENV` environment variable (Node.js)
 * - Build-time configuration (bundlers)
 * - Explicit initialization
 *
 * @example
 * ```typescript
 * import { isTestEnvironment, isBrowserEnvironment, isServiceWorker } from './environment';
 *
 * if (isTestEnvironment()) {
 *   // Skip network calls in tests
 * }
 *
 * if (isBrowserEnvironment() && !isServiceWorker()) {
 *   // Safe to access DOM
 * }
 * ```
 *
 * @module utils/environment
 */

import { RuntimeConfig } from '../core/runtime-config';

/**
 * Environment types
 */
type Environment = 'development' | 'production' | 'test';

declare const importScripts: undefined | ((...urls: string[]) => void);

/**
 * Browser-safe check if running in test environment
 */
export function isTestEnvironment(): boolean {
  return RuntimeConfig.getInstance().environment === 'test';
}

/**
 * Browser-safe check if running in development environment
 */
export function isDevelopmentEnvironment(): boolean {
  return RuntimeConfig.getInstance().environment === 'development';
}

/**
 * Browser-safe check if running in production environment
 */
function isProductionEnvironment(): boolean {
  return RuntimeConfig.getInstance().environment === 'production';
}

/**
 * Get the current environment
 */
export function getEnvironment(): Environment {
  return RuntimeConfig.getInstance().environment;
}

/**
 * Browser-safe check if running in browser environment
 */
function isBrowserEnvironment(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Browser-safe check if running in Node.js environment
 */
function isNodeEnvironment(): boolean {
  return typeof process !== 'undefined' && process.versions?.node !== undefined;
}

/**
 * Browser-safe check if running in extension environment
 */
export function isExtensionEnvironment(): boolean {
  return typeof chrome !== 'undefined' && chrome.runtime !== undefined;
}

/**
 * Browser-safe check if running in web worker environment
 */
function isWebWorkerEnvironment(): boolean {
  return (
    typeof importScripts === 'function' &&
    typeof self !== 'undefined' &&
    'WorkerGlobalScope' in self
  );
}

/**
 * Get safe hostname (works in all environments)
 */
function getHostnameSafe(): string {
  try {
    if (typeof window !== 'undefined' && window.location) {
      return window.location.hostname;
    }
  } catch {
    // Ignore errors
  }
  return '';
}

/**
 * Check if current host is localhost
 */
function isLocalhost(): boolean {
  const hostname = getHostnameSafe();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    hostname.endsWith('.local')
  );
}

/**
 * Get user agent safely
 */
function getUserAgentSafe(): string {
  try {
    if (typeof navigator !== 'undefined') {
      return navigator.userAgent;
    }
  } catch {
    // Ignore errors
  }
  return '';
}

/**
 * Environment information for debugging
 */
interface EnvironmentInfo {
  environment: Environment;
  isBrowser: boolean;
  isNode: boolean;
  isExtension: boolean;
  isWebWorker: boolean;
  isLocalhost: boolean;
  hostname: string;
  userAgent: string;
}

/**
 * Get comprehensive environment information
 */
function getEnvironmentInfo(): EnvironmentInfo {
  return {
    environment: getEnvironment(),
    isBrowser: isBrowserEnvironment(),
    isNode: isNodeEnvironment(),
    isExtension: isExtensionEnvironment(),
    isWebWorker: isWebWorkerEnvironment(),
    isLocalhost: isLocalhost(),
    hostname: getHostnameSafe(),
    userAgent: getUserAgentSafe(),
  };
}
