/**
 * @file Performance Monitoring
 *
 * Lightweight performance metrics and debug helpers with configurable thresholds.
 */

interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: number;
  metadata?: Record<string, any>;
  category?: string;
  tags?: string[];
}

export interface PerformanceStats {
  totalOperations: number;
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
  slowOperations: number;
  operationsPerSecond: number;
  memoryUsage?: number;
}

interface PerformanceConfig {
  slowOperationThreshold: number;
  maxMetricsHistory: number;
  enableMemoryTracking: boolean;
  enableDetailedMetrics: boolean;
  sampleRate: number;
}

interface ActiveTimer {
  operation: string;
  startTime: number;
  startMemory?: number;
  metadata?: Record<string, any>;
}

/**
 * Lightweight performance monitoring system
 */
export class PerformanceMonitor {
  private metrics: PerformanceMetric[] = [];
  private activeTimers = new Map<string, ActiveTimer>();
  private config: PerformanceConfig;
  private timerIdCounter = 0;

  constructor(config: Partial<PerformanceConfig> = {}) {
    this.config = {
      slowOperationThreshold: 1000, // 1 second
      maxMetricsHistory: 1000,
      enableMemoryTracking: false,
      enableDetailedMetrics: true,
      sampleRate: 1.0,
      ...config,
    };
  }

  /**
   * Starts a performance timer
   */
  startTimer(operation: string, metadata?: Record<string, any>): string {
    // Apply sampling
    if (Math.random() > this.config.sampleRate) {
      return `sampled-${this.timerIdCounter++}`;
    }

    const timerId = `timer-${this.timerIdCounter++}`;
    const startTime = performance.now();
    const startMemory = this.config.enableMemoryTracking
      ? this.getMemoryUsage()
      : undefined;

    this.activeTimers.set(timerId, {
      operation,
      startTime,
      startMemory,
      metadata,
    });

    return timerId;
  }

  /**
   * Ends a performance timer and records the metric
   */
  endTimer(
    timerId: string,
    additionalMetadata?: Record<string, any>
  ): PerformanceMetric | null {
    // Handle sampled timers
    if (timerId.startsWith('sampled-')) {
      return null;
    }

    const timer = this.activeTimers.get(timerId);
    if (!timer) {
      console.warn(`Timer ${timerId} not found`);
      return null;
    }

    const endTime = performance.now();
    const duration = endTime - timer.startTime;
    const endMemory = this.config.enableMemoryTracking
      ? this.getMemoryUsage()
      : undefined;

    const metric: PerformanceMetric = {
      operation: timer.operation,
      duration,
      timestamp: Date.now(),
      metadata: {
        ...timer.metadata,
        ...additionalMetadata,
        ...(this.config.enableMemoryTracking && timer.startMemory && endMemory
          ? {
              memoryDelta: endMemory - timer.startMemory,
              startMemory: timer.startMemory,
              endMemory,
            }
          : {}),
      },
    };

    this.activeTimers.delete(timerId);
    this.recordMetric(metric);

    return metric;
  }

  /**
   * Records a metric directly
   */
  recordMetric(metric: PerformanceMetric): void {
    this.metrics.push(metric);

    // Maintain history limit
    if (this.metrics.length > this.config.maxMetricsHistory) {
      this.metrics.shift();
    }

    // Emit warning for slow operations
    if (metric.duration > this.config.slowOperationThreshold) {
      console.warn(
        `Slow operation detected: ${metric.operation} took ${metric.duration.toFixed(2)}ms`
      );
    }
  }

  /**
   * Gets all recorded metrics
   */
  // fallow-ignore-next-line unused-class-member
  getMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }

  /**
   * Gets metrics for a specific operation
   */
  getMetricsForOperation(operation: string): PerformanceMetric[] {
    return this.metrics.filter(m => m.operation === operation);
  }

  /**
   * Gets performance statistics
   */
  getStats(operation?: string): PerformanceStats {
    const relevantMetrics = operation
      ? this.getMetricsForOperation(operation)
      : this.metrics;

    if (relevantMetrics.length === 0) {
      return {
        totalOperations: 0,
        averageDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        slowOperations: 0,
        operationsPerSecond: 0,
      };
    }

    const durations = relevantMetrics.map(m => m.duration);
    const slowOperations = relevantMetrics.filter(
      m => m.duration > this.config.slowOperationThreshold
    ).length;

    // Calculate operations per second over the last minute
    const oneMinuteAgo = Date.now() - 60000;
    const recentMetrics = relevantMetrics.filter(
      m => m.timestamp > oneMinuteAgo
    );
    const operationsPerSecond = recentMetrics.length / 60;

    return {
      totalOperations: relevantMetrics.length,
      averageDuration:
        durations.reduce((sum, d) => sum + d, 0) / durations.length,
      minDuration: Math.min(...durations),
      maxDuration: Math.max(...durations),
      slowOperations,
      operationsPerSecond,
      memoryUsage: this.config.enableMemoryTracking
        ? this.getMemoryUsage()
        : undefined,
    };
  }

  /**
   * Gets slow operations (above threshold)
   */
  // fallow-ignore-next-line unused-class-member
  getSlowOperations(): PerformanceMetric[] {
    return this.metrics.filter(
      m => m.duration > this.config.slowOperationThreshold
    );
  }

  /**
   * Clears all metrics
   */
  // fallow-ignore-next-line unused-class-member
  clearMetrics(): void {
    this.metrics = [];
  }

  /**
   * Gets active timers count
   */
  // fallow-ignore-next-line unused-class-member
  getActiveTimersCount(): number {
    return this.activeTimers.size;
  }

  /**
   * Gets memory usage if available
   */
  private getMemoryUsage(): number | undefined {
    if (typeof performance !== 'undefined' && 'memory' in performance) {
      return (performance as any).memory.usedJSHeapSize;
    }
    return undefined;
  }

  /**
   * Updates configuration
   */
  // fallow-ignore-next-line unused-class-member
  updateConfig(newConfig: Partial<PerformanceConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Gets current configuration
   */
  // fallow-ignore-next-line unused-class-member
  getConfig(): PerformanceConfig {
    return { ...this.config };
  }
}

/**
 * Decorator for measuring method performance
 */
function measurePerformance(
  monitor: PerformanceMonitor,
  operation?: string
) {
  return function (
    target: any,
    propertyName: string,
    descriptor: PropertyDescriptor
  ) {
    const method = descriptor.value;
    const operationName =
      operation || `${target.constructor.name}.${propertyName}`;

    descriptor.value = async function (...args: any[]) {
      const timerId = monitor.startTimer(operationName, {
        args: args.length,
        className: target.constructor.name,
        methodName: propertyName,
      });

      try {
        const result = await method.apply(this, args);
        monitor.endTimer(timerId, { success: true });
        return result;
      } catch (error) {
        monitor.endTimer(timerId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Utility function to measure a function's performance
 */
async function measureFunction<T>(
  monitor: PerformanceMonitor,
  operation: string,
  fn: () => T | Promise<T>,
  metadata?: Record<string, any>
): Promise<{ result: T; metric: PerformanceMetric | null }> {
  const timerId = monitor.startTimer(operation, metadata);

  try {
    const result = await fn();
    const metric = monitor.endTimer(timerId, { success: true });
    return { result, metric };
  } catch (error) {
    monitor.endTimer(timerId, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Global performance monitor instance
 */
export const globalPerformanceMonitor = new PerformanceMonitor();
