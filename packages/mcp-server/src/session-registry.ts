/**
 * @file Bounded registry of hosted MCP sessions.
 *
 * Each session is bound to the SHA-256 digest of the project API key that
 * opened it. The registry enforces a process-wide cap and a per-key cap
 * (so one tenant cannot exhaust the server) and evicts sessions that have
 * been idle longer than the configured TTL.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

export type SessionTransport = StreamableHTTPServerTransport | SSEServerTransport;

export interface SessionEntry {
  transport: SessionTransport;
  server: Server;
  /** SHA-256 digest of the API key the session was opened with. */
  keyHash: Buffer;
  lastSeenAt: number;
}

export interface SessionLimits {
  sessionIdleTtlMs: number;
  maxSessions: number;
  maxSessionsPerKey: number;
}

/** Why a new session was refused. */
export type AdmitRefusal = 'global_limit' | 'key_limit';

/** Capacity held for a session that is still being opened. */
export interface SessionReservation {
  release(): void;
}

/** Constant-time check that a presented key digest matches a session's. */
export function keyHashMatches(bound: Buffer, presented: Buffer): boolean {
  return bound.length === presented.length && timingSafeEqual(bound, presented);
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly pendingByKey = new Map<string, number>();
  private pendingTotal = 0;

  constructor(
    private readonly limits: SessionLimits,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Look up a session without marking it active. */
  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  /**
   * Look up a session and mark it active. Call only after the caller's key
   * matched the session, so a wrong-key request cannot keep another
   * tenant's session from idling out.
   */
  touch(id: string): SessionEntry | undefined {
    const entry = this.sessions.get(id);
    if (entry) entry.lastSeenAt = this.now();
    return entry;
  }

  /**
   * Reserve capacity for a session about to be opened. Sessions still
   * initializing count against the caps so concurrent opens cannot
   * overshoot them. Release the reservation once the open settles.
   */
  reserve(keyHash: Buffer): SessionReservation | AdmitRefusal {
    const keyId = keyHash.toString('hex');
    if (this.sessions.size + this.pendingTotal >= this.limits.maxSessions) {
      return 'global_limit';
    }
    if (this.countForKey(keyId) + (this.pendingByKey.get(keyId) ?? 0) >= this.limits.maxSessionsPerKey) {
      return 'key_limit';
    }
    this.pendingTotal += 1;
    this.pendingByKey.set(keyId, (this.pendingByKey.get(keyId) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.pendingTotal -= 1;
        const left = (this.pendingByKey.get(keyId) ?? 1) - 1;
        if (left > 0) this.pendingByKey.set(keyId, left);
        else this.pendingByKey.delete(keyId);
      },
    };
  }

  add(id: string, entry: Omit<SessionEntry, 'lastSeenAt'>): void {
    this.sessions.set(id, { ...entry, lastSeenAt: this.now() });
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** Remove and return every entry (used on shutdown). */
  drain(): SessionEntry[] {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    return entries;
  }

  /** Remove and return sessions idle for longer than the TTL. */
  evictIdle(): SessionEntry[] {
    const cutoff = this.now() - this.limits.sessionIdleTtlMs;
    const evicted: SessionEntry[] = [];
    for (const [id, entry] of this.sessions) {
      if (entry.lastSeenAt <= cutoff) {
        this.sessions.delete(id);
        evicted.push(entry);
      }
    }
    return evicted;
  }

  private countForKey(keyId: string): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.keyHash.toString('hex') === keyId) count += 1;
    }
    return count;
  }
}
