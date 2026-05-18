/**
 * @file AtomicMemory SDK Logger
 *
 * Lightweight logger abstraction with structured logging, levels, and context.
 * Provides consistent logging across all SDK components with configurable output
 * and structured error handling integration.
 */

/**
 * Log levels in order of severity
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log context for structured logging
 */
export interface LogContext {
  /** Component or module name */
  component?: string;
  /** Operation being performed */
  operation?: string;
  /** Correlation ID for request tracking */
  correlationId?: string;
  /** Performance timing data */
  timing?: {
    startTime?: number;
    duration?: number;
  };
  /** Additional structured data - intentionally `any` for logging flexibility */
  [key: string]: any; // INTENTIONAL: Logs need to accept arbitrary data types from different system components
}

/**
 * Log entry structure
 */
export interface LogEntry {
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Timestamp */
  timestamp: number;
  /** Logger name */
  logger: string;
  /** Structured context */
  context?: LogContext;
  /** Error object if applicable */
  error?: Error;
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Minimum log level to output */
  level: LogLevel;
  /** Whether to include timestamps */
  includeTimestamp: boolean;
  /** Whether to include logger names */
  includeLogger: boolean;
  /** Whether to use colors in console output */
  useColors: boolean;
  /** Custom log formatter */
  formatter?: (entry: LogEntry) => string;
  /** Custom log handler */
  handler?: (entry: LogEntry) => void;
}

/**
 * Default logger configuration
 */
const DEFAULT_CONFIG: LoggerConfig = {
  level: 'info',
  includeTimestamp: true,
  includeLogger: true,
  useColors: true,
};

/**
 * Log level priorities for filtering
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Console colors for different log levels
 */
const COLORS = {
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m', // Green
  warn: '\x1b[33m', // Yellow
  error: '\x1b[31m', // Red
  reset: '\x1b[0m', // Reset
};

/**
 * Logger class with structured logging capabilities
 */
export class Logger {
  private config: LoggerConfig;
  private name: string;

  constructor(name: string, config: Partial<LoggerConfig> = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Updates logger configuration
   */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Gets current configuration
   */
  getConfig(): LoggerConfig {
    return { ...this.config };
  }

  /**
   * Checks if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  /**
   * Formats a log entry for console output
   */
  private formatEntry(entry: LogEntry): string {
    if (this.config.formatter) {
      return this.config.formatter(entry);
    }

    const parts: string[] = [];

    // Timestamp
    if (this.config.includeTimestamp) {
      const timestamp = new Date(entry.timestamp).toISOString();
      parts.push(`[${timestamp}]`);
    }

    // Log level with color
    const levelStr = entry.level.toUpperCase().padEnd(5);
    if (this.config.useColors) {
      const color = COLORS[entry.level];
      parts.push(`${color}${levelStr}${COLORS.reset}`);
    } else {
      parts.push(levelStr);
    }

    // Logger name
    if (this.config.includeLogger) {
      parts.push(`[${entry.logger}]`);
    }

    // Message
    parts.push(entry.message);

    // Context
    if (entry.context && Object.keys(entry.context).length > 0) {
      parts.push(`- ${JSON.stringify(entry.context)}`);
    }

    return parts.join(' ');
  }

  /**
   * Outputs a log entry
   */
  private output(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) {
      return;
    }

    if (this.config.handler) {
      this.config.handler(entry);
      return;
    }

    const formatted = this.formatEntry(entry);

    // Use appropriate console method
    switch (entry.level) {
      case 'debug':
        console.debug(formatted, entry.error || '');
        break;
      case 'info':
        console.info(formatted, entry.error || '');
        break;
      case 'warn':
        console.warn(formatted, entry.error || '');
        break;
      case 'error':
        console.error(formatted, entry.error || '');
        break;
    }
  }

  /**
   * Creates a log entry
   */
  private createEntry(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: Error
  ): LogEntry {
    return {
      level,
      message,
      timestamp: Date.now(),
      logger: this.name,
      context,
      error,
    };
  }

  /**
   * Debug level logging
   */
  debug(message: string, context?: LogContext): void {
    const entry = this.createEntry('debug', message, context);
    this.output(entry);
  }

  /**
   * Info level logging
   */
  info(message: string, context?: LogContext): void {
    const entry = this.createEntry('info', message, context);
    this.output(entry);
  }

  /**
   * Warning level logging
   */
  warn(message: string, context?: LogContext, error?: Error): void {
    const entry = this.createEntry('warn', message, context, error);
    this.output(entry);
  }

  /**
   * Error level logging
   */
  error(message: string, context?: LogContext, error?: Error): void {
    const entry = this.createEntry('error', message, context, error);
    this.output(entry);
  }

  /**
   * Creates a child logger with additional context
   */
  child(name: string, context?: LogContext): Logger {
    const childLogger = new Logger(`${this.name}:${name}`, this.config);

    // If context is provided, wrap all logging methods to include it
    if (context) {
      const originalMethods = {
        debug: childLogger.debug.bind(childLogger),
        info: childLogger.info.bind(childLogger),
        warn: childLogger.warn.bind(childLogger),
        error: childLogger.error.bind(childLogger),
      };

      childLogger.debug = (message: string, additionalContext?: LogContext) => {
        originalMethods.debug(message, { ...context, ...additionalContext });
      };

      childLogger.info = (message: string, additionalContext?: LogContext) => {
        originalMethods.info(message, { ...context, ...additionalContext });
      };

      childLogger.warn = (
        message: string,
        additionalContext?: LogContext,
        error?: Error
      ) => {
        originalMethods.warn(
          message,
          { ...context, ...additionalContext },
          error
        );
      };

      childLogger.error = (
        message: string,
        additionalContext?: LogContext,
        error?: Error
      ) => {
        originalMethods.error(
          message,
          { ...context, ...additionalContext },
          error
        );
      };
    }

    return childLogger;
  }

  /**
   * Performance timing helper
   */
  time(operation: string): () => void {
    const startTime = Date.now();
    return () => {
      const duration = Date.now() - startTime;
      this.debug(`Performance: ${operation}`, {
        operation,
        timing: { startTime, duration },
      });
    };
  }
}

/**
 * Global logger registry
 */
class LoggerRegistry {
  private loggers = new Map<string, Logger>();
  private globalConfig: Partial<LoggerConfig> = {};

  /**
   * Gets or creates a logger
   */
  getLogger(name: string): Logger {
    if (!this.loggers.has(name)) {
      const logger = new Logger(name, this.globalConfig);
      this.loggers.set(name, logger);
    }
    return this.loggers.get(name)!;
  }

  /**
   * Configures all loggers
   */
  configure(config: Partial<LoggerConfig>): void {
    this.globalConfig = { ...this.globalConfig, ...config };
    for (const logger of this.loggers.values()) {
      logger.configure(config);
    }
  }

  /**
   * Sets log level for all loggers
   */
  setLevel(level: LogLevel): void {
    this.configure({ level });
  }
}

/**
 * Global logger registry instance
 */
const registry = new LoggerRegistry();

/**
 * Gets a logger instance
 */
export const getLogger = (name: string): Logger => registry.getLogger(name);

/**
 * Configures all loggers globally
 */
export const configureLogging = (config: Partial<LoggerConfig>): void => {
  registry.configure(config);
};

/**
 * Sets global log level
 */
export const setLogLevel = (level: LogLevel): void => {
  registry.setLevel(level);
};

/**
 * Default SDK logger
 */
export const logger = getLogger('AtomicMemorySDK');

/**
 * Simple logging function for backward compatibility
 * @param category Log category (maps to log level)
 * @param component Component name
 * @param message Log message
 * @param level Optional log level (defaults based on category)
 * @param context Additional context
 */
export const log = (
  category: string,
  component: string,
  message: string,
  level?: LogLevel | string,
  context?: LogContext
): void => {
  const componentLogger = getLogger(component);

  // Map category to log level if level not provided
  let logLevel: LogLevel;
  if (
    level &&
    (level === 'debug' ||
      level === 'info' ||
      level === 'warn' ||
      level === 'error')
  ) {
    logLevel = level as LogLevel;
  } else {
    // Map common categories to log levels
    switch (category.toLowerCase()) {
      case 'error':
      case 'fail':
      case 'failure':
        logLevel = 'error';
        break;
      case 'warn':
      case 'warning':
        logLevel = 'warn';
        break;
      case 'debug':
        logLevel = 'debug';
        break;
      default:
        logLevel = 'info';
        break;
    }
  }

  // Add category to context
  const enrichedContext = { ...context, category };

  switch (logLevel) {
    case 'debug':
      componentLogger.debug(message, enrichedContext);
      break;
    case 'info':
      componentLogger.info(message, enrichedContext);
      break;
    case 'warn':
      componentLogger.warn(message, enrichedContext);
      break;
    case 'error':
      componentLogger.error(message, enrichedContext);
      break;
  }
};
