/**
 * @file Circuit Breaker
 *
 * This module implements circuit breaker patterns for storage adapters.
 * It provides functionality for:
 * - Managing circuit breaker states (closed, open, half-open)
 * - Automatic circuit breaker opening based on failure thresholds
 * - Circuit breaker recovery and testing
 * - Emitting circuit breaker events
 *
 * @example
 * ```typescript
 * import { CircuitBreaker } from './circuit-breaker';
 *
 * const breaker = new CircuitBreaker(config, eventEmitter);
 * breaker.updateCircuitBreaker(adapterId, health);
 * const canExecute = breaker.canExecuteOperation(adapterId);
 * ```
 */

import { EventEmitter } from '../core/events';
import { AdapterHealthStatus, CircuitBreakerConfig } from './types';

/**
 * Circuit breaker for managing adapter availability
 */
export class CircuitBreaker {
  constructor(
    private config: CircuitBreakerConfig,
    private eventEmitter: EventEmitter
  ) {}

  /**
   * Check if operation can be executed on adapter
   */
  canExecuteOperation(
    _adapterId: string,
    health: AdapterHealthStatus
  ): boolean {
    // If circuit breaker is open, check if we should try half-open
    if (health.circuitBreakerOpen) {
      return this.shouldTryHalfOpen(health);
    }

    return health.isHealthy;
  }

  /**
   * Update circuit breaker state based on health status
   */
  updateCircuitBreaker(adapterId: string, health: AdapterHealthStatus): void {
    const now = Date.now();

    // Check if we should open the circuit breaker
    if (!health.circuitBreakerOpen && this.shouldOpenCircuitBreaker(health)) {
      this.openCircuitBreaker(adapterId, health, now);
      return;
    }

    // Check if we should close the circuit breaker (recovery)
    if (health.circuitBreakerOpen && this.shouldCloseCircuitBreaker(health)) {
      this.closeCircuitBreaker(adapterId, health);
    }
  }

  /**
   * Record successful operation for circuit breaker
   */
  recordSuccess(adapterId: string, health: AdapterHealthStatus): void {
    // If circuit breaker is in half-open state and operation succeeded
    if (health.circuitBreakerOpen && health.consecutiveFailures === 0) {
      this.closeCircuitBreaker(adapterId, health);
    }
  }

  /**
   * Record failed operation for circuit breaker
   */
  recordFailure(adapterId: string, health: AdapterHealthStatus): void {
    // Update circuit breaker state after failure
    this.updateCircuitBreaker(adapterId, health);
  }

  /**
   * Check if circuit breaker should be opened
   */
  private shouldOpenCircuitBreaker(health: AdapterHealthStatus): boolean {
    // Need minimum operations before considering circuit breaker
    if (health.totalOperations < this.config.minimumOperations) {
      return false;
    }

    // Check failure rate threshold
    return health.failureRate >= this.config.failureThreshold;
  }

  /**
   * Check if circuit breaker should be closed (recovered)
   */
  private shouldCloseCircuitBreaker(health: AdapterHealthStatus): boolean {
    // Circuit breaker is in half-open state, check if we should close it
    return health.consecutiveFailures === 0;
  }

  /**
   * Check if we should try half-open state
   */
  private shouldTryHalfOpen(health: AdapterHealthStatus): boolean {
    if (!health.circuitBreakerOpenedAt) {
      return false;
    }

    const now = Date.now();
    const timeSinceOpened = now - health.circuitBreakerOpenedAt;

    // Allow limited operations after timeout period
    return timeSinceOpened >= this.config.timeout;
  }

  /**
   * Open circuit breaker
   */
  private openCircuitBreaker(
    adapterId: string,
    health: AdapterHealthStatus,
    timestamp: number
  ): void {
    health.circuitBreakerOpen = true;
    health.circuitBreakerOpenedAt = timestamp;
    health.isHealthy = false;

    this.eventEmitter.emit('circuitBreakerOpened', {
      adapterId,
      failureRate: health.failureRate,
      consecutiveFailures: health.consecutiveFailures,
      totalOperations: health.totalOperations,
    });
  }

  /**
   * Close circuit breaker (recovery)
   */
  private closeCircuitBreaker(
    adapterId: string,
    health: AdapterHealthStatus
  ): void {
    health.circuitBreakerOpen = false;
    health.circuitBreakerOpenedAt = undefined;
    health.isHealthy = true;

    this.eventEmitter.emit('circuitBreakerClosed', {
      adapterId,
      recoveryTime: Date.now() - (health.circuitBreakerOpenedAt || 0),
    });
  }
}
