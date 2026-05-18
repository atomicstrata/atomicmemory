/**
 * @file BaseMemoryProvider Tests
 *
 * Tests the abstract BaseMemoryProvider class by subclassing it with a
 * concrete TestProvider. Covers: runOperation scope validation, initialization
 * gating, resolveExtension behavior, error wrapping, and getExtension typing.
 */

import { describe, it, expect } from 'vitest';
import { BaseMemoryProvider } from '../provider';
import { MemoryProviderError, InvalidScopeError } from '../errors';
import type {
  Scope,
  MemoryRef,
  Memory,
  IngestInput,
  IngestResult,
  SearchRequest,
  SearchResultPage,
  ListRequest,
  ListResultPage,
  Capabilities,
} from '../types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const EMPTY_INGEST_RESULT: IngestResult = {
  created: ['mem-1'],
  updated: [],
  unchanged: [],
};

const STUB_MEMORY: Memory = {
  id: 'mem-1',
  content: 'test content',
  scope: { user: 'u1' },
  createdAt: new Date('2026-01-01'),
};

const EMPTY_SEARCH_PAGE: SearchResultPage = { results: [] };
const EMPTY_LIST_PAGE: ListResultPage = { memories: [] };

function makeCapabilities(
  overrides: Partial<Capabilities> = {}
): Capabilities {
  return {
    ingestModes: ['text'],
    requiredScope: {
      default: ['user'],
      search: ['user', 'namespace'],
      ...overrides.requiredScope,
    },
    extensions: {
      update: false,
      package: true,
      temporal: false,
      graph: false,
      forget: false,
      profile: false,
      reflect: false,
      versioning: false,
      batch: false,
      health: false,
      ...overrides.extensions,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Concrete subclass for testing (constructor-ready by default)
// ---------------------------------------------------------------------------

class TestProvider extends BaseMemoryProvider {
  readonly name = 'TestProvider';
  private caps: Capabilities;

  /** Tracks whether doIngest was actually called. */
  doIngestCalled = false;

  constructor(caps?: Partial<Capabilities>) {
    super();
    this.caps = makeCapabilities(caps);
  }

  capabilities(): Capabilities {
    return this.caps;
  }

  protected async doIngest(_input: IngestInput): Promise<IngestResult> {
    this.doIngestCalled = true;
    return EMPTY_INGEST_RESULT;
  }

  protected async doSearch(
    _request: SearchRequest
  ): Promise<SearchResultPage> {
    return EMPTY_SEARCH_PAGE;
  }

  protected async doGet(_ref: MemoryRef): Promise<Memory | null> {
    return STUB_MEMORY;
  }

  protected async doDelete(_ref: MemoryRef): Promise<void> {
    return;
  }

  protected async doList(_request: ListRequest): Promise<ListResultPage> {
    return EMPTY_LIST_PAGE;
  }
}

// ---------------------------------------------------------------------------
// Subclass that requires async initialization
// ---------------------------------------------------------------------------

class AsyncInitProvider extends TestProvider {
  override readonly name = 'AsyncInitProvider';

  constructor(caps?: Partial<Capabilities>) {
    super(caps);
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }
}

// ---------------------------------------------------------------------------
// Subclass that throws raw errors from doIngest
// ---------------------------------------------------------------------------

class ThrowingProvider extends TestProvider {
  override readonly name = 'ThrowingProvider';

  protected override async doIngest(
    _input: IngestInput
  ): Promise<IngestResult> {
    throw new Error('raw storage failure');
  }
}

// ---------------------------------------------------------------------------
// Subclass that overrides resolveExtension to return a custom object
// ---------------------------------------------------------------------------

interface CustomAnalytics {
  trackEvent(name: string): void;
}

class CustomExtensionProvider extends TestProvider {
  override readonly name = 'CustomExtProvider';
  readonly analytics: CustomAnalytics = {
    trackEvent: () => {
      /* no-op */
    },
  };

  protected override resolveExtension(
    name: string
  ): unknown | undefined {
    if (name === 'analytics') {
      return this.analytics;
    }
    return super.resolveExtension(name);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BaseMemoryProvider', () => {
  describe('runOperation scope validation', () => {
    it('passes when all required scope fields are present', async () => {
      const provider = new TestProvider();
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: { user: 'u1' },
      };

      const result = await provider.ingest(input);

      expect(result.created).toEqual(['mem-1']);
      expect(provider.doIngestCalled).toBe(true);
    });

    it('throws InvalidScopeError when default required fields are missing', async () => {
      const provider = new TestProvider();
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: {},
      };

      await expect(provider.ingest(input)).rejects.toThrow(
        InvalidScopeError
      );
    });

    it('uses operation-specific required scope when defined', async () => {
      const provider = new TestProvider();
      const request: SearchRequest = {
        query: 'find something',
        scope: { user: 'u1' },
      };

      // search requires ['user', 'namespace'] but only user is provided
      await expect(provider.search(request)).rejects.toThrow(
        InvalidScopeError
      );
    });

    it('passes operation-specific scope when all fields present', async () => {
      const provider = new TestProvider();
      const request: SearchRequest = {
        query: 'find something',
        scope: { user: 'u1', namespace: 'ns1' },
      };

      const result = await provider.search(request);

      expect(result.results).toEqual([]);
    });

    it('validates scope for get operation using default required fields', async () => {
      const provider = new TestProvider();
      const ref: MemoryRef = { id: 'mem-1', scope: {} };

      await expect(provider.get(ref)).rejects.toThrow(
        InvalidScopeError
      );
    });

    it('validates scope for delete operation', async () => {
      const provider = new TestProvider();
      const ref: MemoryRef = { id: 'mem-1', scope: {} };

      await expect(provider.delete(ref)).rejects.toThrow(
        InvalidScopeError
      );
    });

    it('validates scope for list operation', async () => {
      const provider = new TestProvider();
      const request: ListRequest = { scope: {} };

      await expect(provider.list(request)).rejects.toThrow(
        InvalidScopeError
      );
    });

    it('includes missing field names in InvalidScopeError message', async () => {
      const provider = new TestProvider({
        requiredScope: { default: ['user', 'agent'] },
      });
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: {},
      };

      try {
        await provider.ingest(input);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidScopeError);
        const scopeErr = err as InvalidScopeError;
        expect(scopeErr.message).toContain('user');
        expect(scopeErr.message).toContain('agent');
      }
    });
  });

  describe('initialization gating', () => {
    it('allows operations immediately on constructor-ready provider', async () => {
      const provider = new TestProvider();
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: { user: 'u1' },
      };

      const result = await provider.ingest(input);

      expect(result.created).toEqual(['mem-1']);
    });

    it('blocks operations before initialize() on async-init provider', async () => {
      const provider = new AsyncInitProvider();
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: { user: 'u1' },
      };

      await expect(provider.ingest(input)).rejects.toThrow(
        MemoryProviderError
      );
    });

    it('includes provider name in not-initialized error message', async () => {
      const provider = new AsyncInitProvider();
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: { user: 'u1' },
      };

      try {
        await provider.ingest(input);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoryProviderError);
        const provErr = err as MemoryProviderError;
        expect(provErr.message).toContain('AsyncInitProvider');
        expect(provErr.message).toContain('initialize');
      }
    });

    it('allows operations after initialize() is called', async () => {
      const provider = new AsyncInitProvider();
      await provider.initialize();

      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: { user: 'u1' },
      };

      const result = await provider.ingest(input);

      expect(result.created).toEqual(['mem-1']);
    });
  });

  describe('resolveExtension', () => {
    it('returns this for a supported standard extension', () => {
      const provider = new TestProvider({ extensions: { package: true } });

      const ext = provider.getExtension('package');

      expect(ext).toBe(provider);
    });

    it('returns undefined for an unsupported extension', () => {
      const provider = new TestProvider({ extensions: { graph: false } });

      const ext = provider.getExtension('graph');

      expect(ext).toBeUndefined();
    });

    it('returns undefined for an unknown extension name', () => {
      const provider = new TestProvider();

      const ext = provider.getExtension('nonexistent');

      expect(ext).toBeUndefined();
    });
  });

  describe('resolveExtension override', () => {
    it('returns custom extension object for custom extension name', () => {
      const provider = new CustomExtensionProvider();

      const ext = provider.getExtension<CustomAnalytics>('analytics');

      expect(ext).toBe(provider.analytics);
    });

    it('falls back to default resolution for standard extensions', () => {
      const provider = new CustomExtensionProvider();

      const ext = provider.getExtension('package');

      expect(ext).toBe(provider);
    });

    it('returns undefined for unsupported non-custom extension', () => {
      const provider = new CustomExtensionProvider();

      const ext = provider.getExtension('graph');

      expect(ext).toBeUndefined();
    });
  });

  describe('error wrapping', () => {
    it('wraps raw Error into MemoryProviderError', async () => {
      const provider = new ThrowingProvider();
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: { user: 'u1' },
      };

      try {
        await provider.ingest(input);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoryProviderError);
        const wrapped = err as MemoryProviderError;
        expect(wrapped.message).toBe('raw storage failure');
        expect(wrapped.provider).toBe('ThrowingProvider');
        expect(wrapped.operation).toBe('ingest');
        expect(wrapped.cause).toBeInstanceOf(Error);
      }
    });

    it('does not double-wrap MemoryProviderError', async () => {
      const original = new MemoryProviderError(
        'already wrapped',
        'SomeProvider',
        'ingest'
      );

      class DoubleWrapProvider extends TestProvider {
        override readonly name = 'DoubleWrapProvider';
        protected override async doIngest(): Promise<IngestResult> {
          throw original;
        }
      }

      const provider = new DoubleWrapProvider();
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: { user: 'u1' },
      };

      try {
        await provider.ingest(input);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBe(original);
      }
    });

    it('wraps non-Error throws into MemoryProviderError', async () => {
      class StringThrowProvider extends TestProvider {
        override readonly name = 'StringThrowProvider';
        protected override async doIngest(): Promise<IngestResult> {
          throw 'string error';
        }
      }

      const provider = new StringThrowProvider();
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: { user: 'u1' },
      };

      try {
        await provider.ingest(input);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoryProviderError);
        const wrapped = err as MemoryProviderError;
        expect(wrapped.message).toBe('string error');
        expect(wrapped.cause?.message).toBe('string error');
      }
    });
  });

  describe('getExtension typing', () => {
    it('returns typed extension when supported', () => {
      const provider = new CustomExtensionProvider();

      const ext = provider.getExtension<CustomAnalytics>('analytics');

      expect(ext).toBeDefined();
      // Verify it has the expected method (runtime type check)
      expect(typeof ext!.trackEvent).toBe('function');
    });

    it('returns undefined when extension is not supported', () => {
      const provider = new TestProvider();

      const ext = provider.getExtension<CustomAnalytics>('analytics');

      expect(ext).toBeUndefined();
    });
  });
});
