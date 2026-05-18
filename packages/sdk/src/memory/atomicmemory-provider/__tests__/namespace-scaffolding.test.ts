/**
 * @file AtomicMemory namespace scaffolding tests
 *
 * Verifies the runtime plumbing of `provider.getExtension('atomicmemory.*')`,
 * `capabilities().customExtensions`, and the placeholder handle's fail-loud
 * async behavior. Route implementations land in Phases 7b–7g.
 */

import { describe, it, expect } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import type {
  AtomicMemoryHandle,
  AtomicMemoryLifecycle,
  AtomicMemoryAudit,
  AtomicMemoryLessons,
  AtomicMemoryConfig,
  AtomicMemoryAgents,
  MemoryScope,
} from '../handle';
import { ATOMICMEMORY_EXTENSION_NAMES } from '../handle';

function createProvider(): AtomicMemoryProvider {
  return new AtomicMemoryProvider({ apiUrl: 'https://example.invalid' });
}

describe('AtomicMemory namespace scaffolding', () => {
  it('declares all atomicmemory.* customExtensions in capabilities', () => {
    const provider = createProvider();
    const caps = provider.capabilities();

    expect(caps.customExtensions).toBeDefined();
    for (const name of ATOMICMEMORY_EXTENSION_NAMES) {
      expect(caps.customExtensions?.[name]).toBeDefined();
      expect(caps.customExtensions?.[name].version).toBe('1.0.0');
    }
  });

  it('returns the root handle for atomicmemory.base', () => {
    const provider = createProvider();
    const handle = provider.getExtension<AtomicMemoryHandle>('atomicmemory.base');
    expect(handle).toBeDefined();
    expect(typeof handle?.ingestFull).toBe('function');
    expect(typeof handle?.lifecycle).toBe('object');
    expect(typeof handle?.audit).toBe('object');
  });

  it('returns the category-specific handle (not the root) for each atomicmemory.<category>', () => {
    const provider = createProvider();

    const lifecycle = provider.getExtension<AtomicMemoryLifecycle>(
      'atomicmemory.lifecycle',
    );
    expect(lifecycle).toBeDefined();
    expect(typeof lifecycle?.consolidate).toBe('function');
    // Not the root handle:
    expect((lifecycle as unknown as AtomicMemoryHandle)?.ingestFull).toBeUndefined();

    const audit = provider.getExtension<AtomicMemoryAudit>('atomicmemory.audit');
    expect(audit).toBeDefined();
    expect(typeof audit?.summary).toBe('function');
    expect((audit as unknown as AtomicMemoryHandle)?.ingestFull).toBeUndefined();

    const lessons = provider.getExtension<AtomicMemoryLessons>(
      'atomicmemory.lessons',
    );
    expect(typeof lessons?.list).toBe('function');
    expect((lessons as unknown as AtomicMemoryHandle)?.ingestFull).toBeUndefined();

    const config = provider.getExtension<AtomicMemoryConfig>('atomicmemory.config');
    expect(typeof config?.health).toBe('function');
    expect((config as unknown as AtomicMemoryHandle)?.ingestFull).toBeUndefined();

    const agents = provider.getExtension<AtomicMemoryAgents>('atomicmemory.agents');
    expect(typeof agents?.getTrust).toBe('function');
    expect((agents as unknown as AtomicMemoryHandle)?.ingestFull).toBeUndefined();
  });

  it('returns undefined for unknown custom extension names', () => {
    const provider = createProvider();
    expect(provider.getExtension('unknown.ext')).toBeUndefined();
    expect(provider.getExtension('mem0.filter')).toBeUndefined();
  });

  it('serves category handles backed by a single root handle instance', () => {
    const provider = createProvider();
    const base = provider.getExtension<AtomicMemoryHandle>('atomicmemory.base');
    const lifecycle = provider.getExtension<AtomicMemoryLifecycle>(
      'atomicmemory.lifecycle',
    );
    expect(lifecycle).toBe(base?.lifecycle);
  });

  // Every category now has a real HTTP-wired implementation — category-by-
  // category coverage lives in the dedicated test files:
  //   base routes   → namespace-base-routes.test.ts
  //   lifecycle     → namespace-lifecycle.test.ts
  //   audit         → namespace-audit.test.ts
  //   lessons       → namespace-lessons.test.ts
  //   config        → namespace-config.test.ts
  //   agents        → namespace-agents.test.ts
});
