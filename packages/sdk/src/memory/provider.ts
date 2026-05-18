/**
 * @file V3 Memory Provider Interface and Base Class
 *
 * Defines the MemoryProvider interface, standard extension interfaces,
 * and the BaseMemoryProvider abstract class with runOperation() enforcement.
 */

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
  PackageRequest,
  ContextPackage,
  GraphSearchRequest,
  GraphResult,
  Profile,
  Insight,
  MemoryVersion,
  HealthStatus,
} from './types';
import {
  MemoryProviderError,
  InvalidScopeError,
} from './errors';

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface MemoryProvider {
  readonly name: string;

  initialize?(): Promise<void>;
  close?(): Promise<void>;

  ingest(input: IngestInput): Promise<IngestResult>;
  search(request: SearchRequest): Promise<SearchResultPage>;
  get(ref: MemoryRef): Promise<Memory | null>;
  delete(ref: MemoryRef): Promise<void>;
  list(request: ListRequest): Promise<ListResultPage>;

  capabilities(): Capabilities;
  getExtension?<T = unknown>(name: string): T | undefined;
}

// ---------------------------------------------------------------------------
// Extension interfaces
// ---------------------------------------------------------------------------

export interface Updater {
  update(ref: MemoryRef, content: string): Promise<Memory>;
}

export interface Packager {
  package(request: PackageRequest): Promise<ContextPackage>;
}

export interface TemporalSearch {
  searchAsOf(
    request: SearchRequest & { asOf: Date }
  ): Promise<SearchResultPage>;
}

export interface GraphSearch {
  searchGraph(request: GraphSearchRequest): Promise<GraphResult>;
}

export interface Forgetter {
  forget(ref: MemoryRef, reason?: string): Promise<void>;
}

export interface Profiler {
  profile(scope: Scope, instructions?: string[]): Promise<Profile>;
}

export interface Reflector {
  reflect(query: string, scope: Scope): Promise<Insight[]>;
}

export interface Versioner {
  history(ref: MemoryRef): Promise<MemoryVersion[]>;
}

export interface BatchOps {
  batchIngest(inputs: IngestInput[]): Promise<IngestResult[]>;
  batchDelete(refs: MemoryRef[]): Promise<void>;
}

export interface Health {
  health(): Promise<HealthStatus>;
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export abstract class BaseMemoryProvider implements MemoryProvider {
  abstract readonly name: string;

  /** Override to `false` in constructor to require async init. */
  protected initialized = true;

  protected abstract doIngest(input: IngestInput): Promise<IngestResult>;
  protected abstract doSearch(
    request: SearchRequest
  ): Promise<SearchResultPage>;
  protected abstract doGet(ref: MemoryRef): Promise<Memory | null>;
  protected abstract doDelete(ref: MemoryRef): Promise<void>;
  protected abstract doList(request: ListRequest): Promise<ListResultPage>;
  abstract capabilities(): Capabilities;

  /**
   * Generic enforcement for core AND extension operations.
   * Validates readiness and scope, wraps errors.
   */
  protected async runOperation<T>(
    operation: string,
    scope: Scope | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    this.assertReady();
    if (scope) {
      this.validateScope(scope, operation);
    }
    try {
      return await fn();
    } catch (err) {
      throw this.wrapError(operation, err);
    }
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    return this.runOperation('ingest', input.scope, () =>
      this.doIngest(input)
    );
  }

  async search(request: SearchRequest): Promise<SearchResultPage> {
    return this.runOperation('search', request.scope, () =>
      this.doSearch(request)
    );
  }

  // fallow-ignore-next-line unused-class-member
  async get(ref: MemoryRef): Promise<Memory | null> {
    return this.runOperation('get', ref.scope, () => this.doGet(ref));
  }

  // fallow-ignore-next-line unused-class-member
  async delete(ref: MemoryRef): Promise<void> {
    return this.runOperation('delete', ref.scope, () =>
      this.doDelete(ref)
    );
  }

  // fallow-ignore-next-line unused-class-member
  async list(request: ListRequest): Promise<ListResultPage> {
    return this.runOperation('list', request.scope, () =>
      this.doList(request)
    );
  }

  /**
   * Default extension resolution: checks capabilities().extensions
   * and returns `this` for supported standard extensions.
   * Subclasses override for custom extensions.
   */
  protected resolveExtension(name: string): unknown | undefined {
    const caps = this.capabilities();
    const extKey = name as keyof typeof caps.extensions;
    if (caps.extensions[extKey]) {
      return this;
    }
    return undefined;
  }

  getExtension<T = unknown>(name: string): T | undefined {
    return this.resolveExtension(name) as T | undefined;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  protected assertReady(): void {
    if (!this.initialized) {
      throw new MemoryProviderError(
        `${this.name} is not initialized. Call initialize() first.`,
        this.name,
        'assertReady'
      );
    }
  }

  protected validateScope(scope: Scope, operation: string): void {
    const caps = this.capabilities();
    const requiredForOp =
      caps.requiredScope[
        operation as keyof typeof caps.requiredScope
      ] ?? caps.requiredScope.default;

    if (!requiredForOp || requiredForOp.length === 0) {
      return;
    }

    const missing = requiredForOp.filter(
      (field) => !scope[field]
    );

    if (missing.length > 0) {
      throw new InvalidScopeError(this.name, missing as string[]);
    }
  }

  protected wrapError(operation: string, err: unknown): Error {
    if (err instanceof MemoryProviderError) {
      return err;
    }
    const cause = err instanceof Error ? err : new Error(String(err));
    return new MemoryProviderError(
      cause.message,
      this.name,
      operation,
      cause
    );
  }
}
