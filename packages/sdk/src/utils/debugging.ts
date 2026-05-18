/**
 * @file Debug Utilities
 *
 * Debug helpers and development tools for SDK inspection and troubleshooting.
 */

import { PerformanceMonitor, PerformanceStats } from './performance';

interface DebugInfo {
  timestamp: number;
  version: string;
  environment: {
    userAgent?: string;
    platform?: string;
    language?: string;
    memory?: {
      used: number;
      total: number;
      limit: number;
    };
  };
  storageStats: {
    adapters: string[];
    totalSize: number;
    itemCount: number;
    errors: string[];
  };
  performanceMetrics: PerformanceStats;
  configSnapshot: Record<string, any>;
  activeComponents: string[];
  errors: Array<{
    timestamp: number;
    message: string;
    stack?: string;
    component?: string;
  }>;
}

interface BenchmarkResult {
  operation: string;
  iterations: number;
  totalTime: number;
  averageTime: number;
  minTime: number;
  maxTime: number;
  operationsPerSecond: number;
}

interface DebugConfig {
  enableConsoleOutput: boolean;
  enablePerformanceTracking: boolean;
  maxErrorHistory: number;
  benchmarkIterations: number;
}

/**
 * Debug tools for SDK inspection and troubleshooting
 */
export class DebugTools {
  private performanceMonitor: PerformanceMonitor;
  private errors: Array<{
    timestamp: number;
    message: string;
    stack?: string;
    component?: string;
  }> = [];
  private config: DebugConfig;

  constructor(
    performanceMonitor?: PerformanceMonitor,
    config: Partial<DebugConfig> = {}
  ) {
    this.performanceMonitor = performanceMonitor || new PerformanceMonitor();
    this.config = {
      enableConsoleOutput: true,
      enablePerformanceTracking: true,
      maxErrorHistory: 100,
      benchmarkIterations: 1000,
      ...config,
    };
  }

  /**
   * Comprehensive SDK inspection
   */
  async inspectSDK(components?: {
    storageManager?: any;
    configManager?: any;
    embeddingGenerator?: any;
    semanticSearch?: any;
  }): Promise<DebugInfo> {
    const timestamp = Date.now();

    // Environment information
    const environment = this.getEnvironmentInfo();

    // Storage statistics
    const storageStats = await this.getStorageStats(components?.storageManager);

    // Performance metrics
    const performanceMetrics = this.performanceMonitor.getStats();

    // Configuration snapshot
    const configSnapshot = this.getConfigSnapshot(components?.configManager);

    // Active components
    const activeComponents = this.getActiveComponents(components);

    return {
      timestamp,
      version: '1.0.0', // Should be dynamically determined
      environment,
      storageStats,
      performanceMetrics,
      configSnapshot,
      activeComponents,
      errors: [...this.errors],
    };
  }

  /**
   * Benchmark SDK operations
   */
  async benchmarkOperations(operations?: {
    [operationName: string]: () => Promise<any> | any;
  }): Promise<Record<string, BenchmarkResult>> {
    const defaultOperations = {
      'string-processing': () => {
        const text = 'Lorem ipsum '.repeat(100);
        return text.split(' ').join('-').toLowerCase();
      },
      'array-operations': () => {
        const arr = Array.from({ length: 1000 }, (_, i) => i);
        return arr.filter(x => x % 2 === 0).map(x => x * 2);
      },
      'object-creation': () => {
        return Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `item-${i}`,
          value: Math.random(),
        }));
      },
    };

    const testOperations = operations || defaultOperations;
    const results: Record<string, BenchmarkResult> = {};

    for (const [operationName, operation] of Object.entries(testOperations)) {
      const times: number[] = [];

      // Warm up
      for (let i = 0; i < 10; i++) {
        await operation();
      }

      // Benchmark
      for (let i = 0; i < this.config.benchmarkIterations; i++) {
        const start = performance.now();
        await operation();
        const end = performance.now();
        times.push(end - start);
      }

      const totalTime = times.reduce((sum, time) => sum + time, 0);
      const averageTime = totalTime / times.length;
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const operationsPerSecond = 1000 / averageTime;

      results[operationName] = {
        operation: operationName,
        iterations: this.config.benchmarkIterations,
        totalTime,
        averageTime,
        minTime,
        maxTime,
        operationsPerSecond,
      };
    }

    return results;
  }

  /**
   * Log an error for debugging
   */
  // fallow-ignore-next-line unused-class-member
  logError(error: Error | string, component?: string): void {
    const errorEntry = {
      timestamp: Date.now(),
      message: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      component,
    };

    this.errors.push(errorEntry);

    // Maintain error history limit
    if (this.errors.length > this.config.maxErrorHistory) {
      this.errors.shift();
    }

    if (this.config.enableConsoleOutput) {
      console.error(`[DEBUG] ${component || 'Unknown'}: ${errorEntry.message}`);
      if (errorEntry.stack) {
        console.error(errorEntry.stack);
      }
    }
  }

  /**
   * Get environment information
   */
  private getEnvironmentInfo() {
    const env: any = {
      timestamp: Date.now(),
    };

    if (typeof navigator !== 'undefined') {
      env.userAgent = navigator.userAgent;
      env.platform = navigator.platform;
      env.language = navigator.language;
    }

    if (typeof performance !== 'undefined' && 'memory' in performance) {
      const memory = (performance as any).memory;
      env.memory = {
        used: memory.usedJSHeapSize,
        total: memory.totalJSHeapSize,
        limit: memory.jsHeapSizeLimit,
      };
    }

    return env;
  }

  /**
   * Get storage statistics
   */
  private async getStorageStats(storageManager?: any) {
    const stats = {
      adapters: [] as string[],
      totalSize: 0,
      itemCount: 0,
      errors: [] as string[],
    };

    if (storageManager) {
      try {
        // Try to get stats from storage manager
        if (typeof storageManager.getStats === 'function') {
          const managerStats = await storageManager.getStats();
          stats.adapters = managerStats.adapters || [];
          stats.totalSize = managerStats.totalSize || 0;
          stats.itemCount = managerStats.itemCount || 0;
        }

        if (typeof storageManager.getErrors === 'function') {
          stats.errors = await storageManager.getErrors();
        }
      } catch (error) {
        stats.errors.push(
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return stats;
  }

  /**
   * Get configuration snapshot
   */
  private getConfigSnapshot(configManager?: any): Record<string, any> {
    if (configManager && typeof configManager.getConfig === 'function') {
      try {
        return configManager.getConfig();
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {};
  }

  /**
   * Get active components
   */
  private getActiveComponents(components?: Record<string, any>): string[] {
    const active: string[] = [];

    if (components) {
      for (const [name, component] of Object.entries(components)) {
        if (component) {
          active.push(name);
        }
      }
    }

    return active;
  }

  /**
   * Generate a debug report as a formatted string
   */
  // fallow-ignore-next-line unused-class-member
  async generateReport(components?: {
    storageManager?: any;
    configManager?: any;
    embeddingGenerator?: any;
    semanticSearch?: any;
  }): Promise<string> {
    const info = await this.inspectSDK(components);
    const benchmarks = await this.benchmarkOperations();

    let report = '=== AtomicMemory SDK Debug Report ===\n\n';

    report += `Timestamp: ${new Date(info.timestamp).toISOString()}\n`;
    report += `Version: ${info.version}\n\n`;

    report += '--- Environment ---\n';
    report += `Platform: ${info.environment.platform || 'Unknown'}\n`;
    report += `User Agent: ${info.environment.userAgent || 'Unknown'}\n`;
    if (info.environment.memory) {
      report += `Memory Usage: ${(info.environment.memory.used / 1024 / 1024).toFixed(2)} MB\n`;
    }
    report += '\n';

    report += '--- Storage ---\n';
    report += `Adapters: ${info.storageStats.adapters.join(', ') || 'None'}\n`;
    report += `Total Size: ${info.storageStats.totalSize} bytes\n`;
    report += `Item Count: ${info.storageStats.itemCount}\n`;
    if (info.storageStats.errors.length > 0) {
      report += `Errors: ${info.storageStats.errors.join(', ')}\n`;
    }
    report += '\n';

    report += '--- Performance ---\n';
    report += `Total Operations: ${info.performanceMetrics.totalOperations}\n`;
    report += `Average Duration: ${info.performanceMetrics.averageDuration.toFixed(2)}ms\n`;
    report += `Slow Operations: ${info.performanceMetrics.slowOperations}\n`;
    report += `Operations/sec: ${info.performanceMetrics.operationsPerSecond.toFixed(2)}\n\n`;

    report += '--- Benchmarks ---\n';
    for (const [name, result] of Object.entries(benchmarks)) {
      report += `${name}: ${result.averageTime.toFixed(2)}ms avg (${result.operationsPerSecond.toFixed(0)} ops/sec)\n`;
    }
    report += '\n';

    report += '--- Active Components ---\n';
    report += info.activeComponents.join(', ') || 'None';
    report += '\n\n';

    if (info.errors.length > 0) {
      report += '--- Recent Errors ---\n';
      info.errors.slice(-5).forEach(error => {
        report += `[${new Date(error.timestamp).toISOString()}] ${error.component || 'Unknown'}: ${error.message}\n`;
      });
    }

    return report;
  }

  /**
   * Clear error history
   */
  // fallow-ignore-next-line unused-class-member
  clearErrors(): void {
    this.errors = [];
  }

  /**
   * Get error count
   */
  // fallow-ignore-next-line unused-class-member
  getErrorCount(): number {
    return this.errors.length;
  }

  /**
   * Update debug configuration
   */
  // fallow-ignore-next-line unused-class-member
  updateConfig(newConfig: Partial<DebugConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}

/**
 * Global debug tools instance
 */
export const globalDebugTools = new DebugTools();
