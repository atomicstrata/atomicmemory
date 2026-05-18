/**
 * @file AtomicMemory SDK Event System
 *
 * This file provides a strongly-typed event system for the AtomicMemory SDK.
 * It enables communication between different SDK components and allows
 * consumers to listen for SDK lifecycle events, operations, and errors.
 *
 * The event system features:
 * - Strongly typed events with TypeScript
 * - Type-safe event listeners and emitters
 * - Automatic cleanup and memory management
 * - Support for once-only listeners
 * - Error handling for event listeners
 *
 * @example
 * ```typescript
 * import { EventEmitter } from './events';
 *
 * const emitter = new EventEmitter();
 *
 * emitter.on('contextAdded', (event) => {
 *   console.log(`Added context: ${event.contextId}`);
 * });
 *
 * emitter.emit('contextAdded', { contextId: 'user-123', content: 'data' });
 * ```
 */

import { getLogger } from '../utils/logger';

/**
 * Base interface for all SDK events
 */
interface BaseEvent {
  /** Timestamp when the event occurred */
  timestamp: number;
  /** Unique identifier for this event instance */
  eventId: string;
}

/**
 * Context-related events
 */
interface ContextAddedEvent extends BaseEvent {
  contextId: string;
  userId: string;
  contentLength: number;
  metadata?: Record<string, any>; // INTENTIONAL: Context metadata can contain arbitrary structured data
}

interface ContextSearchedEvent extends BaseEvent {
  query: string;
  userId: string;
  resultCount: number;
  searchTime: number;
}

interface ContextDeletedEvent extends BaseEvent {
  contextId: string;
  userId: string;
}

/**
 * Storage-related events
 */
interface StorageInitializedEvent extends BaseEvent {
  adapterType: string;
  databaseName?: string;
}

interface StorageErrorEvent extends BaseEvent {
  error: Error;
  operation: string;
  key?: string;
  retryCount?: number;
  attemptNumber?: number;
  finalAttempt?: boolean;
  success?: boolean;
}

/**
 * Performance-related events
 */
interface PerformanceMetricEvent extends BaseEvent {
  operation: string;
  duration: number;
  metadata?: Record<string, any>; // INTENTIONAL: Performance metadata can contain arbitrary measurement data
}

interface SlowOperationEvent extends BaseEvent {
  operation: string;
  duration: number;
  threshold: number;
}

/**
 * SDK lifecycle events
 */
interface SDKInitializedEvent extends BaseEvent {
  config: Record<string, any>; // INTENTIONAL: SDK config can contain arbitrary configuration values
  version: string;
}

interface SDKErrorEvent extends BaseEvent {
  error: Error;
  context?: Record<string, any>; // INTENTIONAL: Error context can contain arbitrary debugging information
  retryable?: boolean;
  attemptNumber?: number;
}

/**
 * Adapter unhealthy event payload
 */
interface AdapterUnhealthyEvent extends BaseEvent {
  adapterId: string;
  consecutiveFailures: number;
  failureRate: number;
}

/**
 * Adapter recovered event payload
 */
interface AdapterRecoveredEvent extends BaseEvent {
  adapterId: string;
  totalOperations: number;
  failureRate: number;
}

/**
 * Circuit breaker opened event payload
 */
interface CircuitBreakerOpenedEvent extends BaseEvent {
  adapterId: string;
  failureRate: number;
  consecutiveFailures: number;
  totalOperations: number;
}

/**
 * Circuit breaker closed event payload
 */
interface CircuitBreakerClosedEvent extends BaseEvent {
  adapterId: string;
  recoveryTime: number;
}

/**
 * Operation failed event payload
 */
interface OperationFailedEvent extends BaseEvent {
  operationId: string;
  type: 'set' | 'delete';
  key: string;
  failedAdapters: string[];
}

/**
 * Operation repaired event payload
 */
interface OperationRepairedEvent extends BaseEvent {
  operationId: string;
  key: string;
  repairedAdapters: number;
}

/**
 * Operation abandoned event payload
 */
interface OperationAbandonedEvent extends BaseEvent {
  operationId: string;
  key: string;
  reason: 'expired' | 'max_attempts';
}

/**
 * Storage retry success event payload
 */
interface StorageRetrySuccessEvent extends BaseEvent {
  operation: string;
  key?: string;
  attemptNumber: number;
  totalAttempts: number;
  totalDuration: number;
  finalError?: string; // The error that was overcome
}

/**
 * Storage retry attempt event payload
 */
interface StorageRetryAttemptEvent extends BaseEvent {
  operation: string;
  key?: string;
  attemptNumber: number;
  maxAttempts: number;
  delay: number;
  error: string;
  isRetryable: boolean;
}

/**
 * Quorum evaluation event payload
 */
interface QuorumEvaluationEvent extends BaseEvent {
  operation: 'read' | 'write';
  requiredQuorum: number;
  availableAdapters: number;
  healthyAdapters: string[];
  unhealthyAdapters: string[];
  quorumSatisfied: boolean;
  requiresPrimary: boolean;
  primaryHealthy?: boolean;
}

/**
 * Operation dropped event payload
 */
interface OperationDroppedEvent extends BaseEvent {
  operationId: string;
  key: string;
  type: 'set' | 'delete';
  reason: 'queue-full' | 'too-old' | 'max-attempts-exceeded';
  evictionPolicy?: string;
  queueSize: number;
  maxQueueSize: number;
}


  // Search-related events
  interface SearchCacheHitEvent extends BaseEvent {
    query: string;
    resultCount: number;
  }

  interface SearchNoContextsEvent extends BaseEvent {
    query: string;
  }

  interface SearchNoResultsEvent extends BaseEvent {
    query: string;
    totalContexts: number;
  }

  interface SearchCompletedEvent extends BaseEvent {
    query: string;
    resultCount: number;
    totalContexts: number;
    filteredContexts: number;
    searchTime: number;
    averageScore: number;
  }

  interface SearchErrorEvent extends BaseEvent {
    query: string;
    error: string;
  }

  interface SearchContextAddedEvent extends BaseEvent {
    contextId: string;
    contentLength: number;
  }

  interface SearchContextRemovedEvent extends BaseEvent {
    contextId: string;
  }

  interface SearchContextsClearedEvent extends BaseEvent {
    prefix?: string;
  }

  interface SearchCacheClearedEvent extends BaseEvent {
    previousSize: number;
  }

/**
 * Parameter pack events
 */
interface PackUpdatedEvent extends BaseEvent {
  indexId: string;
  pack: any;
}

interface EpochRotatedEvent extends BaseEvent {
  indexId: string;
  oldEpoch: number;
  newEpoch: number;
}

interface ValidationFailedEvent extends BaseEvent {
  indexId: string;
  error: string;
  pack?: any;
}

interface CaptureBlockedEvent extends BaseEvent {
  contextId: string;
  platform: string;
  reason: string;
}

interface InjectionBlockedEvent extends BaseEvent {
  query: string;
  domain: string;
  reason: string;
}

/**
 * Union type of all possible events
 */
type SDKEvent =
  | ContextAddedEvent
  | ContextSearchedEvent
  | ContextDeletedEvent
  | StorageInitializedEvent
  | StorageErrorEvent
  | PerformanceMetricEvent
  | SlowOperationEvent
  | SDKInitializedEvent
  | SDKErrorEvent
  | AdapterUnhealthyEvent
  | AdapterRecoveredEvent
  | CircuitBreakerOpenedEvent
  | CircuitBreakerClosedEvent
  | OperationFailedEvent
  | OperationRepairedEvent
  | OperationAbandonedEvent
  | StorageRetrySuccessEvent
  | StorageRetryAttemptEvent
  | QuorumEvaluationEvent
  | OperationDroppedEvent
  | SearchCacheHitEvent
  | SearchNoContextsEvent
  | SearchNoResultsEvent
  | SearchCompletedEvent
  | SearchErrorEvent
  | SearchContextAddedEvent
  | SearchContextRemovedEvent
  | SearchContextsClearedEvent
  | SearchCacheClearedEvent
  | PackUpdatedEvent
  | EpochRotatedEvent
  | ValidationFailedEvent
  | CaptureBlockedEvent
  | InjectionBlockedEvent;

/**
 * Event type names mapped to their event interfaces
 */
export interface EventMap {
  contextAdded: ContextAddedEvent;
  contextSearched: ContextSearchedEvent;
  contextDeleted: ContextDeletedEvent;
  storageInitialized: StorageInitializedEvent;
  storageError: StorageErrorEvent;
  performanceMetric: PerformanceMetricEvent;
  slowOperation: SlowOperationEvent;
  sdkInitialized: SDKInitializedEvent;
  sdkError: SDKErrorEvent;
  // Resilience Manager Events
  adapterUnhealthy: AdapterUnhealthyEvent;
  adapterRecovered: AdapterRecoveredEvent;
  operationFailed: OperationFailedEvent;
  circuitBreakerOpened: CircuitBreakerOpenedEvent;
  circuitBreakerClosed: CircuitBreakerClosedEvent;
  operationRepaired: OperationRepairedEvent;
  operationAbandoned: OperationAbandonedEvent;
  // Storage Manager Events
  storageRetrySuccess: StorageRetrySuccessEvent;
  storageRetryAttempt: StorageRetryAttemptEvent;
  quorumEvaluation: QuorumEvaluationEvent;
  operationDropped: OperationDroppedEvent;
  // Search events
  searchCacheHit: SearchCacheHitEvent;
  searchNoContexts: SearchNoContextsEvent;
  searchNoResults: SearchNoResultsEvent;
  searchCompleted: SearchCompletedEvent;
  searchError: SearchErrorEvent;
  searchContextAdded: SearchContextAddedEvent;
  searchContextRemoved: SearchContextRemovedEvent;
  searchContextsCleared: SearchContextsClearedEvent;
  searchCacheCleared: SearchCacheClearedEvent;
  // Parameter pack events
  'pack-updated': PackUpdatedEvent;
  'epoch-rotated': EpochRotatedEvent;
  'validation-failed': ValidationFailedEvent;
  // User Accounts filtering events
  captureBlocked: CaptureBlockedEvent;
  injectionBlocked: InjectionBlockedEvent;
}

/**
 * Event listener function type
 */
type EventListener<T extends SDKEvent> = (
  event: T
) => void | Promise<void>;

/**
 * Event listener options
 */
interface ListenerOptions {
  /** Whether this listener should only fire once */
  once?: boolean;
  /** Priority for listener execution (higher = earlier) */
  priority?: number;
}

/**
 * Internal listener wrapper
 */
interface ListenerWrapper<T extends SDKEvent> {
  listener: EventListener<T>;
  options: ListenerOptions;
  id: string;
}

/**
 * Strongly-typed event emitter for SDK events
 */
export class EventEmitter {
  private listeners = new Map<keyof EventMap, ListenerWrapper<any>[]>();
  private eventIdCounter = 0;

  /**
   * Adds an event listener
   *
   * @param eventType - Type of event to listen for
   * @param listener - Function to call when event occurs
   * @param options - Listener configuration options
   * @returns Unique listener ID for removal
   */
  on<K extends keyof EventMap>(
    eventType: K,
    listener: EventListener<EventMap[K]>,
    options: ListenerOptions = {}
  ): string {
    const listenerId = `listener_${++this.eventIdCounter}`;
    const wrapper: ListenerWrapper<EventMap[K]> = {
      listener,
      options,
      id: listenerId,
    };

    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }

    const eventListeners = this.listeners.get(eventType)!;
    eventListeners.push(wrapper);

    // Sort by priority (higher priority first)
    eventListeners.sort(
      (a, b) => (b.options.priority || 0) - (a.options.priority || 0)
    );

    return listenerId;
  }

  /**
   * Adds a one-time event listener
   *
   * @param eventType - Type of event to listen for
   * @param listener - Function to call when event occurs
   * @param options - Listener configuration options
   * @returns Unique listener ID for removal
   */
  // fallow-ignore-next-line unused-class-member
  once<K extends keyof EventMap>(
    eventType: K,
    listener: EventListener<EventMap[K]>,
    options: Omit<ListenerOptions, 'once'> = {}
  ): string {
    return this.on(eventType, listener, { ...options, once: true });
  }

  /**
   * Removes an event listener
   *
   * @param eventType - Type of event
   * @param listenerId - ID returned from on() or once()
   * @returns Whether the listener was found and removed
   */
  off<K extends keyof EventMap>(eventType: K, listenerId: string): boolean {
    const eventListeners = this.listeners.get(eventType);
    if (!eventListeners) {
      return false;
    }

    const index = eventListeners.findIndex(
      wrapper => wrapper.id === listenerId
    );
    if (index === -1) {
      return false;
    }

    eventListeners.splice(index, 1);

    // Clean up empty listener arrays
    if (eventListeners.length === 0) {
      this.listeners.delete(eventType);
    }

    return true;
  }

  /**
   * Emits an event to all registered listeners
   *
   * @param eventType - Type of event to emit
   * @param eventData - Event data (without timestamp and eventId)
   */
  async emit<K extends keyof EventMap>(
    eventType: K,
    eventData: Omit<EventMap[K], 'timestamp' | 'eventId'>
  ): Promise<void> {
    const eventListeners = this.listeners.get(eventType);
    if (!eventListeners || eventListeners.length === 0) {
      return;
    }

    // Create complete event object
    const event: EventMap[K] = {
      ...(eventData as any),
      timestamp: Date.now(),
      eventId: `event_${++this.eventIdCounter}`,
    } as EventMap[K];

    // Execute listeners in priority order
    const listenersToRemove: string[] = [];

    for (const wrapper of eventListeners) {
      try {
        const result = wrapper.listener(event);

        // Handle async listeners: fully await to ensure ordering expectations in tests
        if (result instanceof Promise) {
          await result;
        }

        // Mark once-only listeners for removal
        if (wrapper.options.once) {
          listenersToRemove.push(wrapper.id);
        }
      } catch (error) {
        const logger = getLogger('EventEmitter');
        logger.error(
          'Event listener error',
          {
            component: 'events',
            operation: 'emit',
            eventType,
            listenerId: wrapper.id,
          },
          error instanceof Error ? error : new Error(String(error))
        );

        // Emit generic error event for consumers/tests
        // Avoid recursion if already handling an error event
        if ((eventType as any) !== 'error') {
          // Best-effort emit; do not await to avoid cascading delays
          (this as any).emit('error' as any, {
            error: error instanceof Error ? error : new Error(String(error)),
            event: String(eventType),
            listener: wrapper.id,
          } as any);
        }

        // Avoid infinite recursion by checking if this is already an sdkError event
        if (eventType !== 'sdkError') {
          this.emit('sdkError', {
            error: error instanceof Error ? error : new Error(String(error)),
            context: { eventType, listenerId: wrapper.id },
          });
        }
      }
    }

    // Remove once-only listeners
    for (const listenerId of listenersToRemove) {
      this.off(eventType, listenerId);
    }
  }

  /**
   * Removes all listeners for a specific event type
   *
   * @param eventType - Type of event to clear listeners for
   */
  // fallow-ignore-next-line unused-class-member
  removeAllListeners<K extends keyof EventMap>(eventType?: K): void {
    if (eventType) {
      this.listeners.delete(eventType);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Gets the number of listeners for an event type
   *
   * @param eventType - Type of event
   * @returns Number of registered listeners
   */
  listenerCount<K extends keyof EventMap>(eventType: K): number {
    const eventListeners = this.listeners.get(eventType);
    return eventListeners ? eventListeners.length : 0;
  }

  /**
   * Gets all event types that have listeners
   *
   * @returns Array of event type names
   */
  // fallow-ignore-next-line unused-class-member
  eventNames(): (keyof EventMap)[] {
    return Array.from(this.listeners.keys());
  }

  /**
   * Checks if an event type has any listeners
   *
   * @param eventType - Type of event to check
   * @returns Whether the event type has listeners
   */
  // fallow-ignore-next-line unused-class-member
  hasListeners<K extends keyof EventMap>(eventType: K): boolean {
    return this.listenerCount(eventType) > 0;
  }
}
