/**
 * Lightweight timing instrumentation for profiling search and ingest paths.
 * Collects per-operation latencies and reports P50/P95/P99 summaries.
 */

export interface TimingEntry {
  operation: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

const entries: TimingEntry[] = [];

/** Time an async operation and record its duration. */
export async function timed<T>(
  operation: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>,
): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  entries.push({ operation, durationMs, metadata });
  console.log(`[timing] ${operation}: ${durationMs.toFixed(1)}ms`);
  return result;
}

/** Time a sync operation and record its duration. */
export function timedSync<T>(
  operation: string,
  fn: () => T,
  metadata?: Record<string, unknown>,
): T {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  entries.push({ operation, durationMs, metadata });
  console.log(`[timing] ${operation}: ${durationMs.toFixed(1)}ms`);
  return result;
}

/** Get all collected timing entries. */
function getTimingEntries(): TimingEntry[] {
  return [...entries];
}

/** Clear collected entries. */
function clearTimingEntries(): void {
  entries.length = 0;
}

/** Compute percentile from sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Generate a summary report of all collected timings, grouped by operation. */
function getTimingSummary(): Record<string, { count: number; p50: number; p95: number; p99: number; mean: number; total: number }> {
  const grouped = new Map<string, number[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.operation) ?? [];
    list.push(entry.durationMs);
    grouped.set(entry.operation, list);
  }

  const summary: Record<string, { count: number; p50: number; p95: number; p99: number; mean: number; total: number }> = {};
  for (const [op, durations] of grouped) {
    const sorted = [...durations].sort((a, b) => a - b);
    const total = sorted.reduce((a, b) => a + b, 0);
    summary[op] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      mean: total / sorted.length,
      total,
    };
  }
  return summary;
}

/** Print a formatted timing report to console. */
function printTimingReport(): void {
  const summary = getTimingSummary();
  console.log('\n=== TIMING REPORT ===');
  console.log('| Operation | Count | P50 | P95 | P99 | Mean | Total |');
  console.log('|-----------|-------|-----|-----|-----|------|-------|');
  for (const [op, stats] of Object.entries(summary).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `| ${op} | ${stats.count} | ${stats.p50.toFixed(1)}ms | ${stats.p95.toFixed(1)}ms | ${stats.p99.toFixed(1)}ms | ${stats.mean.toFixed(1)}ms | ${stats.total.toFixed(0)}ms |`,
    );
  }
  console.log();
}
