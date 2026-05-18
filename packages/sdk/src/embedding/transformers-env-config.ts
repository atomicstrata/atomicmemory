/**
 * @file Transformers.js Environment Configuration
 *
 * Centralized configuration for transformers.js environment settings.
 * This module MUST be imported before any other transformers.js imports
 * to ensure proper environment setup.
 *
 * Diagnostic logs route through the SDK's debug logger (`debugLog`)
 * which is a no-op unless a host installs a handler and calls
 * `setDebugEnabled(true)`. Importing the SDK MUST NOT write to stdout
 * by default — downstream CLIs and agent loops parse stdout/stderr
 * strictly, and an unconditional `console.log` here breaks every
 * machine-mode envelope the moment a provider command runs.
 */

import { env } from '@huggingface/transformers';
import { runtimeConfig } from '../core/runtime-config';
import { debugLog } from '../utils/debug-logger';
import { isExtensionEnvironment } from '../utils/environment';

// Configure transformers.js environment for local model support
env.allowLocalModels = true;

// Runtime configuration is the single source of truth for remote model access
const allowRemoteOverride = runtimeConfig.allowRemoteModels;
env.allowRemoteModels = allowRemoteOverride === true;

// Disable browser cache for chrome-extension:// URLs to avoid Cache API errors
const inExtension = isExtensionEnvironment();
const hasCacheApi = typeof caches !== 'undefined';
env.useBrowserCache = inExtension && hasCacheApi;
if (!inExtension) {
  env.useBrowserCache = false;
}

// Configure ONNX Runtime to use local WASM files in extension
if (
  inExtension &&
  typeof chrome !== 'undefined' &&
  chrome.runtime &&
  typeof chrome.runtime.getURL === 'function'
) {
  // Set WASM paths to extension root to load bundled WASM files
  const wasmPath = chrome.runtime.getURL('');

  // Configure ONNX Runtime backends
  if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.wasmPaths = wasmPath;
    env.backends.onnx.wasm.numThreads = 1; // Start with single thread for stability

    debugLog('TRANSFORMERS-ENV', 'ONNX Runtime WASM paths configured', {
      wasmPaths: wasmPath,
      numThreads: env.backends.onnx.wasm.numThreads,
    });
  }
}

debugLog('TRANSFORMERS-ENV', 'Environment configured globally', {
  allowLocalModels: env.allowLocalModels,
  allowRemoteModels: env.allowRemoteModels,
  useBrowserCache: env.useBrowserCache,
  inExtension,
});
