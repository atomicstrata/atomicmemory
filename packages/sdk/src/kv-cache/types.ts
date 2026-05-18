/**
 * @file Storage Type Definitions
 *
 * This file provides precise TypeScript types for the AtomicMemory SDK storage system,
 * replacing generic Record<string, any> types with specific interfaces for better
 * type safety and developer experience.
 *
 * @example
 * ```typescript
 * import { StorageSetOptions, StorageInitConfig } from './types';
 *
 * const options: StorageSetOptions = {
 *   ttl: 3600,
 *   priority: 'high',
 *   metadata: { source: 'user-input' }
 * };
 * ```
 */

/**
 * Storage operation priority levels
 */
type StoragePriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Storage adapter types
 */
type StorageAdapterType =
  | 'memory'
  | 'indexeddb'
  | 'localstorage'
  | 'custom';

/**
 * Storage operation metadata
 */
interface StorageMetadata {
  /** Source of the data (e.g., 'user-input', 'api-response', 'cache') */
  source?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Creation timestamp */
  createdAt?: number;
  /** Last modified timestamp */
  updatedAt?: number;
  /** Data version for conflict resolution */
  version?: number;
  /** Custom application-specific metadata */
  custom?: Record<string, string | number | boolean>;
}

/**
 * Options for storage set operations
 */
export interface StorageSetOptions {
  /** Time-to-live in seconds */
  ttl?: number;
  /** Operation priority */
  priority?: StoragePriority;
  /** Storage metadata */
  metadata?: StorageMetadata;
  /** Whether to overwrite existing values */
  overwrite?: boolean;
  /** Whether to emit events for this operation */
  silent?: boolean;
}

/**
 * Storage adapter configuration
 */
interface StorageAdapterConfig {
  /** Adapter type */
  type: StorageAdapterType;
  /** Maximum storage size in bytes */
  maxSize?: number;
  /** Default TTL in seconds */
  defaultTtl?: number;
  /** Whether to enable compression */
  compression?: boolean;
  /** Custom adapter-specific options */
  options?: Record<string, unknown>;
}

/**
 * Storage manager initialization configuration
 */
interface StorageInitConfig {
  /** Primary storage adapter configuration */
  primary: StorageAdapterConfig;
  /** Secondary storage adapters for redundancy */
  secondary?: StorageAdapterConfig[];
  /** Write quorum (minimum successful writes) */
  writeQuorum?: number;
  /** Read preference */
  readPreference?: 'primary' | 'secondary' | 'any';
  /** Health check configuration */
  healthCheck?: {
    /** Health check interval in milliseconds */
    interval: number;
    /** Timeout for health checks */
    timeout: number;
    /** Number of failed checks before marking unhealthy */
    failureThreshold: number;
  };
  /** Retry configuration */
  retry?: {
    /** Maximum retry attempts */
    maxAttempts: number;
    /** Initial delay in milliseconds */
    initialDelay: number;
    /** Backoff multiplier */
    backoffMultiplier: number;
  };
}

/**
 * Storage statistics
 */
export interface StorageStats {
  /** Total number of keys */
  keyCount: number;
  /** Back-compat: total number of items (alias of keyCount) */
  itemCount?: number;
  /** Total storage size in bytes */
  totalSize: number;
  /** Available storage space in bytes */
  availableSize?: number;
  /** Storage utilization percentage */
  utilization: number;
  /** Number of operations performed */
  operationCount: {
    get: number;
    set: number;
    delete: number;
    batch: number;
  };
  /** Performance metrics */
  performance: {
    /** Average operation latency in milliseconds */
    averageLatency: number;
    /** Operations per second */
    operationsPerSecond: number;
  };
  /** Health status */
  health: {
    /** Whether the adapter is healthy */
    isHealthy: boolean;
    /** Last health check timestamp */
    lastCheck: number;
    /** Number of consecutive failures */
    failureCount: number;
  };
}

/**
 * Storage validation constraints
 */
/**
 * Storage adapter capabilities
 */
export interface StorageCapabilities {
  /** Maximum key length supported */
  maxKeyLength: number;
  /** Maximum value size supported in bytes */
  maxValueSize: number;
  /** Maximum total storage size in bytes */
  maxTotalSize: number;
  /** Whether the adapter supports encryption */
  supportsEncryption: boolean;
  /** Whether the adapter supports compression */
  supportsCompression: boolean;
  /** Whether the adapter supports expiration */
  supportsExpiration: boolean;
  /** Whether the adapter supports atomic transactions */
  supportsTransactions: boolean;
  /** Whether the adapter supports batch operations */
  supportsBatch: boolean;
}

/**
 * Adapter health status for resilience monitoring
 */
export interface AdapterHealthStatus {
  /** Adapter identifier */
  adapterId: string;
  /** Whether the adapter is currently healthy */
  isHealthy: boolean;
  /** Last successful health check timestamp */
  lastHealthCheck: number;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Total number of operations attempted */
  totalOperations: number;
  /** Total number of failed operations */
  failedOperations: number;
  /** Current failure rate (0-1) */
  failureRate: number;
  /** Whether the adapter is currently in circuit breaker mode */
  circuitBreakerOpen: boolean;
  /** When the circuit breaker was opened */
  circuitBreakerOpenedAt?: number;
  /** Average response time in milliseconds */
  averageResponseTime: number;
  /** Last error encountered */
  lastError?: {
    message: string;
    code: string;
    timestamp: number;
  };
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Failure threshold (0-1) to open circuit */
  failureThreshold: number;
  /** Minimum number of operations before circuit can open */
  minimumOperations: number;
  /** Time in milliseconds to wait before attempting to close circuit */
  timeout: number;
  /** Number of test operations to perform when half-open */
  testOperations: number;
}

/**
 * Health check configuration
 */
export interface HealthCheckConfig {
  /** Health check interval in milliseconds */
  interval: number;
  /** Timeout for health check operations */
  timeout: number;
  /** Number of failed checks before marking unhealthy */
  failureThreshold: number;
  /** Whether to perform deep health checks */
  deepCheck: boolean;
}

/**
 * Write quorum configuration
 */
interface QuorumConfig {
  /** Minimum number of successful writes required */
  writeQuorum: number;
  /** Minimum number of successful reads required */
  readQuorum: number;
  /** Whether to require primary adapter in quorum */
  requirePrimary: boolean;
  /** Timeout for quorum operations */
  timeout: number;
}

/**
 * Background repair configuration
 */
export interface RepairConfig {
  /** Whether background repair is enabled */
  enabled: boolean;
  /** Repair check interval in milliseconds */
  interval: number;
  /** Maximum number of keys to repair per batch */
  batchSize: number;
  /** Maximum age of failed operations to repair (milliseconds) */
  maxAge: number;
  /** Maximum number of repair attempts per key */
  maxAttempts: number;
  /** Maximum number of failed operations to keep in memory */
  maxQueueSize?: number;
  /** Eviction policy when queue is full */
  evictionPolicy?: 'oldest' | 'least-attempts' | 'random';
}

/**
 * Failed operation record for repair tracking
 */
export interface FailedOperation {
  /** Operation ID */
  id: string;
  /** Operation type */
  type: 'set' | 'delete';
  /** Storage key */
  key: string;
  /** Value for set operations */
  value?: unknown;
  /** Operation options */
  options?: unknown;
  /** Adapters that failed */
  failedAdapters: string[];
  /** When the operation failed */
  timestamp: number;
  /** Number of repair attempts */
  repairAttempts: number;
  /** Last repair attempt timestamp */
  lastRepairAttempt?: number;
}

/**
 * Resilience manager configuration
 */
export interface ResilienceConfig {
  /** Circuit breaker configuration */
  circuitBreaker: CircuitBreakerConfig;
  /** Health check configuration */
  healthCheck: HealthCheckConfig;
  /** Write quorum configuration */
  quorum: QuorumConfig;
  /** Background repair configuration */
  repair: RepairConfig;
}
