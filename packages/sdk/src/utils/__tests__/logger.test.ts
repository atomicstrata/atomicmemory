/**
 * @file Logger Tests
 *
 * Comprehensive tests for the AtomicMemory SDK logger abstraction.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  Logger,
  getLogger,
  configureLogging,
  setLogLevel,
  logger,
  type LogLevel,
  type LogContext,
  type LogEntry
} from '../../../src/utils/logger';

describe('Logger', () => {
  let testLogger: Logger;
  let consoleSpy: {
    debug: any;
    info: any;
    warn: any;
    error: any;
  };

  beforeEach(() => {
    testLogger = new Logger('test');

    // Spy on console methods
    consoleSpy = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {})
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor and configuration', () => {
    it('should create logger with default configuration', () => {
      const config = testLogger.getConfig();
      expect(config.level).toBe('info');
      expect(config.includeTimestamp).toBe(true);
      expect(config.includeLogger).toBe(true);
      expect(config.useColors).toBe(true);
    });

    it('should accept custom configuration', () => {
      const customLogger = new Logger('custom', {
        level: 'debug',
        includeTimestamp: false,
        useColors: false
      });

      const config = customLogger.getConfig();
      expect(config.level).toBe('debug');
      expect(config.includeTimestamp).toBe(false);
      expect(config.useColors).toBe(false);
    });

    it('should update configuration', () => {
      testLogger.configure({ level: 'error', useColors: false });
      const config = testLogger.getConfig();
      expect(config.level).toBe('error');
      expect(config.useColors).toBe(false);
    });
  });

  describe('log level filtering', () => {
    it('should respect log level filtering', () => {
      testLogger.configure({ level: 'warn' });

      testLogger.debug('debug message');
      testLogger.info('info message');
      testLogger.warn('warn message');
      testLogger.error('error message');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalledOnce();
      expect(consoleSpy.error).toHaveBeenCalledOnce();
    });

    it('should log all levels when set to debug', () => {
      testLogger.configure({ level: 'debug' });

      testLogger.debug('debug message');
      testLogger.info('info message');
      testLogger.warn('warn message');
      testLogger.error('error message');

      expect(consoleSpy.debug).toHaveBeenCalledOnce();
      expect(consoleSpy.info).toHaveBeenCalledOnce();
      expect(consoleSpy.warn).toHaveBeenCalledOnce();
      expect(consoleSpy.error).toHaveBeenCalledOnce();
    });
  });

  describe('structured logging', () => {
    it('should log with context', () => {
      const context: LogContext = {
        component: 'storage',
        operation: 'get',
        correlationId: 'test-123'
      };

      testLogger.info('test message', context);

      expect(consoleSpy.info).toHaveBeenCalledWith(
        expect.stringContaining('test message'),
        ''
      );

      const call = consoleSpy.info.mock.calls[0][0];
      expect(call).toContain('{"component":"storage","operation":"get","correlationId":"test-123"}');
    });

    it('should log errors with error objects', () => {
      const error = new Error('test error');
      const context: LogContext = { operation: 'test' };

      testLogger.error('operation failed', context, error);

      expect(consoleSpy.error).toHaveBeenCalledWith(
        expect.stringContaining('operation failed'),
        error
      );
    });

    it('should handle empty context gracefully', () => {
      testLogger.info('test message', {});
      expect(consoleSpy.info).toHaveBeenCalledWith(
        expect.stringContaining('test message'),
        ''
      );
    });
  });

  describe('formatting', () => {
    it('should include timestamp when configured', () => {
      testLogger.configure({ includeTimestamp: true });
      testLogger.info('test message');

      const call = consoleSpy.info.mock.calls[0][0];
      expect(call).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    });

    it('should exclude timestamp when configured', () => {
      testLogger.configure({ includeTimestamp: false });
      testLogger.info('test message');

      const call = consoleSpy.info.mock.calls[0][0];
      expect(call).not.toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    });

    it('should include logger name when configured', () => {
      testLogger.configure({ includeLogger: true });
      testLogger.info('test message');

      const call = consoleSpy.info.mock.calls[0][0];
      expect(call).toContain('[test]');
    });

    it('should exclude logger name when configured', () => {
      testLogger.configure({ includeLogger: false });
      testLogger.info('test message');

      const call = consoleSpy.info.mock.calls[0][0];
      expect(call).not.toContain('[test]');
    });

    it('should use colors when configured', () => {
      testLogger.configure({ useColors: true });
      testLogger.error('test message');

      const call = consoleSpy.error.mock.calls[0][0];
      expect(call).toContain('\x1b[31m'); // Red color for error
      expect(call).toContain('\x1b[0m');  // Reset color
    });

    it('should not use colors when disabled', () => {
      testLogger.configure({ useColors: false });
      testLogger.error('test message');

      const call = consoleSpy.error.mock.calls[0][0];
      expect(call).not.toContain('\x1b[31m');
      expect(call).not.toContain('\x1b[0m');
    });
  });

  describe('custom formatter', () => {
    it('should use custom formatter when provided', () => {
      const customFormatter = (entry: LogEntry) => `CUSTOM: ${entry.message}`;
      testLogger.configure({ formatter: customFormatter });

      testLogger.info('test message');

      expect(consoleSpy.info).toHaveBeenCalledWith('CUSTOM: test message', '');
    });
  });

  describe('custom handler', () => {
    it('should use custom handler when provided', () => {
      const customHandler = vi.fn();
      testLogger.configure({ handler: customHandler });

      testLogger.info('test message', { test: 'context' });

      expect(customHandler).toHaveBeenCalledWith({
        level: 'info',
        message: 'test message',
        timestamp: expect.any(Number),
        logger: 'test',
        context: { test: 'context' }
      });

      expect(consoleSpy.info).not.toHaveBeenCalled();
    });
  });

  describe('child loggers', () => {
    it('should create child logger with extended name', () => {
      const childLogger = testLogger.child('child');
      childLogger.info('test message');

      const call = consoleSpy.info.mock.calls[0][0];
      expect(call).toContain('[test:child]');
    });

    it('should create child logger with inherited context', () => {
      const context: LogContext = { component: 'parent' };
      const childLogger = testLogger.child('child', context);

      childLogger.info('test message', { operation: 'test' });

      const call = consoleSpy.info.mock.calls[0][0];
      expect(call).toContain('{"component":"parent","operation":"test"}');
    });
  });

  describe('performance timing', () => {
    it('should provide timing functionality', () => {
      testLogger.configure({ level: 'debug' });
      const endTimer = testLogger.time('test-operation');

      // Immediately call the timer
      endTimer();

      expect(consoleSpy.debug).toHaveBeenCalledWith(
        expect.stringContaining('Performance: test-operation'),
        ''
      );

      const call = consoleSpy.debug.mock.calls[0][0];
      expect(call).toMatch(/Performance: test-operation.*"operation":"test-operation"/);
    });
  });

  describe('global logger registry', () => {
    it('should get same logger instance for same name', () => {
      const logger1 = getLogger('test-registry');
      const logger2 = getLogger('test-registry');
      expect(logger1).toBe(logger2);
    });

    it('should configure all loggers globally', () => {
      const logger1 = getLogger('global-test-1');
      const logger2 = getLogger('global-test-2');

      configureLogging({ level: 'error' });

      expect(logger1.getConfig().level).toBe('error');
      expect(logger2.getConfig().level).toBe('error');
    });

    it('should set log level globally', () => {
      const logger1 = getLogger('level-test-1');
      const logger2 = getLogger('level-test-2');

      setLogLevel('debug');

      expect(logger1.getConfig().level).toBe('debug');
      expect(logger2.getConfig().level).toBe('debug');
    });
  });

  describe('default SDK logger', () => {
    it('should provide default SDK logger', () => {
      expect(logger).toBeInstanceOf(Logger);
      logger.info('test message');

      const call = consoleSpy.info.mock.calls[0][0];
      expect(call).toContain('[AtomicMemorySDK]');
    });
  });
});
