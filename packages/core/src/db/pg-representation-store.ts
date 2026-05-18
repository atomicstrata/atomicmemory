/**
 * Postgres-backed RepresentationStore implementation.
 * Manages atomic facts and foresight projections.
 */

import type pg from 'pg';
import type { RepresentationStore } from './stores.js';
import {
  listAtomicFactsForMemory,
  listForesightForMemory,
  replaceAtomicFactsForMemory,
  replaceForesightForMemory,
  storeAtomicFacts,
  storeForesight,
  type StoreAtomicFactInput,
  type StoreForesightInput,
} from './repository-representations.js';

export class PgRepresentationStore implements RepresentationStore {
  constructor(private pool: pg.Pool) {}

  async storeAtomicFacts(facts: StoreAtomicFactInput[]) { return storeAtomicFacts(this.pool, facts); }
  async storeForesight(entries: StoreForesightInput[]) { return storeForesight(this.pool, entries); }
  async listAtomicFactsForMemory(userId: string, parentMemoryId: string) { return listAtomicFactsForMemory(this.pool, userId, parentMemoryId); }
  async listForesightForMemory(userId: string, parentMemoryId: string) { return listForesightForMemory(this.pool, userId, parentMemoryId); }
  async replaceAtomicFactsForMemory(userId: string, parentMemoryId: string, facts: StoreAtomicFactInput[]) { return replaceAtomicFactsForMemory(this.pool, userId, parentMemoryId, facts); }
  async replaceForesightForMemory(userId: string, parentMemoryId: string, entries: StoreForesightInput[]) { return replaceForesightForMemory(this.pool, userId, parentMemoryId, entries); }
}
