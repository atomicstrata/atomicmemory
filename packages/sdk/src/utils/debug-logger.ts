/**
 * @file SDK Debug Logger
 *
 * Provides a debug logging mechanism that can be hooked by the extension
 * to capture SDK-internal logs. This bypasses issues with bundled console.log
 * references not being interceptable.
 *
 * Usage in SDK code:
 *   import { debugLog } from '../utils/debug-logger';
 *   debugLog('CTX-MGR', 'addContext called', { id, contentLength });
 *
 * Usage in extension:
 *   import { setDebugHandler } from '@your-app/atomicmemory-browser-bridge';
 *   setDebugHandler((entry) => chrome.runtime.sendMessage({ type: 'SDK_DEBUG_LOG', entry }));
 */

export interface DebugLogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  data?: unknown;
}

export type DebugLogHandler = (entry: DebugLogEntry) => void;

let globalDebugHandler: DebugLogHandler | null = null;
let debugEnabled = false;

/**
 * Set a global debug handler that receives all SDK debug logs.
 * Pass null to disable the handler.
 */
export function setDebugHandler(handler: DebugLogHandler | null): void {
  globalDebugHandler = handler;
}

/**
 * Enable or disable debug logging entirely.
 * When disabled, debugLog calls are no-ops.
 */
export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

/**
 * Check if debug logging is enabled.
 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Log a debug message with category and optional data.
 *
 * @param category - Short category identifier (e.g., 'CTX-MGR', 'HTTP', 'PROVIDER')
 * @param message - Human-readable message
 * @param data - Optional structured data to include
 */
export function debugLog(category: string, message: string, data?: unknown): void {
  if (!debugEnabled) {
    return;
  }

  const entry: DebugLogEntry = {
    timestamp: Date.now(),
    level: 'debug',
    category,
    message,
    data,
  };

  // Always log to console with distinctive prefix
  const prefix = `🔷 [SDK:${category}]`;
  if (data !== undefined) {
    console.log(prefix, message, data);
  } else {
    console.log(prefix, message);
  }

  // Call handler if set
  if (globalDebugHandler) {
    try {
      globalDebugHandler(entry);
    } catch {
      // Ignore handler errors to prevent SDK disruption
    }
  }
}

/**
 * Log an info-level message.
 */
export function debugInfo(category: string, message: string, data?: unknown): void {
  if (!debugEnabled) {
    return;
  }

  const entry: DebugLogEntry = {
    timestamp: Date.now(),
    level: 'info',
    category,
    message,
    data,
  };

  const prefix = `🔷 [SDK:${category}]`;
  if (data !== undefined) {
    console.info(prefix, message, data);
  } else {
    console.info(prefix, message);
  }

  if (globalDebugHandler) {
    try {
      globalDebugHandler(entry);
    } catch {
      // Ignore handler errors
    }
  }
}

/**
 * Log a warning-level message.
 */
export function debugWarn(category: string, message: string, data?: unknown): void {
  if (!debugEnabled) {
    return;
  }

  const entry: DebugLogEntry = {
    timestamp: Date.now(),
    level: 'warn',
    category,
    message,
    data,
  };

  const prefix = `⚠️ [SDK:${category}]`;
  if (data !== undefined) {
    console.warn(prefix, message, data);
  } else {
    console.warn(prefix, message);
  }

  if (globalDebugHandler) {
    try {
      globalDebugHandler(entry);
    } catch {
      // Ignore handler errors
    }
  }
}

/**
 * Log an error-level message.
 */
export function debugError(category: string, message: string, data?: unknown): void {
  if (!debugEnabled) {
    return;
  }

  const entry: DebugLogEntry = {
    timestamp: Date.now(),
    level: 'error',
    category,
    message,
    data,
  };

  const prefix = `❌ [SDK:${category}]`;
  if (data !== undefined) {
    console.error(prefix, message, data);
  } else {
    console.error(prefix, message);
  }

  if (globalDebugHandler) {
    try {
      globalDebugHandler(entry);
    } catch {
      // Ignore handler errors
    }
  }
}
