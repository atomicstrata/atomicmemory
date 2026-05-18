/**
 * Timeline-pack formatting — derived retrieval projection.
 *
 * Groups memories within a namespace that span multiple distinct dates into
 * a chronologically-ordered timeline with the latest entry explicitly tagged
 * [CURRENT]. This gives the answering LLM an unambiguous signal for which
 * value is most recent, targeting knowledge-update failures where older
 * values outrank newer ones in flat chronological injection.
 *
 * This is a formatting-only transform — same memories in, differently
 * formatted text out. No changes to ingestion, retrieval, or storage.
 */

import type { SearchResult } from '../db/memory-repository.js';
import { isAnswerBearing } from './session-packaging.js';

export interface TimelineEntry {
  memoryId: string;
  date: string;
  content: string;
  isCurrent: boolean;
}

export interface TimelinePack {
  topic: string;
  entries: TimelineEntry[];
  latestEntryId: string;
}

/** True when memories span at least 2 distinct calendar dates. */
export function spansMultipleDates(memories: SearchResult[]): boolean {
  const dates = new Set<string>();
  for (const m of memories) {
    dates.add(m.created_at.toISOString().slice(0, 10));
    if (dates.size >= 2) return true;
  }
  return false;
}

/**
 * Build a single timeline pack from memories sharing a namespace.
 * Memories are sorted chronologically; the most recent gets isCurrent=true.
 */
export function buildTimelinePack(topic: string, memories: SearchResult[]): TimelinePack {
  const sorted = [...memories].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  const latestEntry = sorted[sorted.length - 1];
  const entries: TimelineEntry[] = sorted.map((m) => ({
    memoryId: m.id,
    date: m.created_at.toISOString().slice(0, 10),
    content: m.content,
    isCurrent: m.id === latestEntry.id,
  }));
  return { topic, entries, latestEntryId: latestEntry.id };
}

/**
 * Format a timeline pack as injection text.
 * Each entry is a dash-delimited line; the latest carries a [CURRENT] tag.
 */
export function formatTimelinePack(pack: TimelinePack): string {
  const lines = pack.entries.map((e) => {
    const kind = isAnswerBearing(e.content) ? 'answer' : 'context';
    const currentTag = e.isCurrent ? ' [CURRENT]' : '';
    return `- [${e.date}] [${kind}]${currentTag} ${e.content}`;
  });
  return `### Timeline: ${pack.topic}\n${lines.join('\n')}`;
}
