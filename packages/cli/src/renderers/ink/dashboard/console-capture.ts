/**
 * @file Console capture for dashboard subcommands. A few dependencies
 * still write directly to console; the dashboard captures those writes
 * during a command so the alternate-screen frame stays intact and the
 * user can still see useful diagnostics in the session output.
 */

import { formatWithOptions } from 'node:util';

export async function runWithCapturedConsole<T>(
  fn: () => Promise<T>,
): Promise<{ captured: string; error?: unknown; result: T }> {
  const original = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const captured: string[] = [];
  const capture = (...args: unknown[]) => {
    captured.push(formatWithOptions({ colors: false }, ...args));
  };

  // Captures only console writes made while fn is awaited. Detached
  // timers that log later use the restored console methods.
  console.debug = capture;
  console.error = capture;
  console.info = capture;
  console.log = capture;
  console.warn = capture;

  try {
    return { result: await fn(), captured: captured.join('\n') };
  } catch (error) {
    return { result: undefined as T, error, captured: captured.join('\n') };
  } finally {
    console.debug = original.debug;
    console.error = original.error;
    console.info = original.info;
    console.log = original.log;
    console.warn = original.warn;
  }
}

export function withCapturedConsoleOutput(body: string, captured: string): string {
  const sanitized = sanitizeCapturedDashboardWrites(captured);
  if (!sanitized) return body;
  return ['[captured console output]', sanitized, body].filter((line) => line.length > 0).join('\n');
}

export function sanitizeCapturedDashboardWrites(value: string): string {
  const lines = value.split('\n');
  const kept: string[] = [];
  let skippingTransformersEnv = false;

  for (const line of lines) {
    if (line.includes('[TRANSFORMERS-ENV]')) {
      skippingTransformersEnv = true;
      continue;
    }
    if (skippingTransformersEnv) {
      if (line.trim() === '}') skippingTransformersEnv = false;
      continue;
    }
    kept.push(line);
  }

  return kept.join('\n').trim();
}
