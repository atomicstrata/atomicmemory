/**
 * @file Deterministic helpers for LiveLLMWikiProvider.doIngest.
 *
 * Provides role-preserving message flattening and stable title derivation
 * so that repeated ingest calls on the same input produce identical text.
 */
import type { Message } from "@atomicmemory/sdk";

/** Maximum characters allowed in a derived title. */
const TITLE_MAX = 120;

/** Stable title when no text or metadata yields a non-empty line. */
const FALLBACK_TITLE = "Untitled source";

/**
 * Flattens a message array into a deterministic plain-text block.
 *
 * Each message is rendered as `[role]\n<content>`, and blocks are joined
 * by a blank line (`\n\n`). Role labels are preserved verbatim so callers
 * can recover the turn structure from the text alone.
 */
export function flattenMessages(messages: Message[]): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

/**
 * Derives a bounded display title with a clear precedence order:
 * 1. `metadata.title` — explicit caller-supplied title (trimmed, max 120 chars).
 * 2. First non-empty trimmed line of `text`.
 * 3. `"Untitled source"` as a stable fallback.
 */
// fallow-ignore-next-line complexity
export function deriveTitle(
  text: string,
  metadata: Record<string, unknown> | undefined
): string {
  const explicit = metadata?.title;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim().slice(0, TITLE_MAX);
  }
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (firstLine ?? FALLBACK_TITLE).slice(0, TITLE_MAX);
}
