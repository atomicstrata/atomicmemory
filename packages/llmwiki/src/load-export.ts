/**
 * Read, size-guard, depth-guard, and schema-validate an llmwiki bridge
 * JSON export from disk.
 *
 * **Memory profile.** This is a *bounded read with streaming size
 * enforcement*, NOT a streaming parse. We stream bytes off disk and
 * abort as soon as the accumulator exceeds `MAX_TOTAL_SIZE_BYTES`,
 * but then `JSON.parse` materializes the full object graph in memory
 * before any further processing. Peak memory is approximately
 * 2× file size (raw string + parsed graph) plus chunk overhead. For
 * a 256 MB ceiling, plan for ~700 MB peak. True streaming parse
 * (e.g. via `stream-json`) is a v2 conversation.
 *
 * Layered defense, in order:
 *
 *   1. `createReadStream` accumulates bytes and aborts the read as soon
 *      as `MAX_TOTAL_SIZE_BYTES` is exceeded — fail-safe against a
 *      file that grows between `stat` and `readFile` (the previous
 *      implementation's TOCTOU gap) and against pipes that don't have
 *      a stable `stat`-able size at all.
 *   2. A raw-string nesting prescan rejects pathologically nested input
 *      BEFORE `JSON.parse` materializes the object graph — `JSON.parse`
 *      would otherwise still allocate the whole tree even if the
 *      post-parse depth guard would later reject it.
 *   3. `JSON.parse` on the bounded buffer.
 *   4. `assertNestingDepthSafe` walks the parsed document iteratively
 *      as defense in depth against the prescan missing an edge case,
 *      and ALSO enforces a per-string size cap so unknown passthrough
 *      fields can't carry oversized payloads through the schema.
 *   5. Zod schema validates the shape and enforces per-field caps.
 *
 * **Defense-in-depth cost.** The raw prescan (step 2) walks the raw
 * string char-by-char and the post-parse walker (step 4) walks the
 * parsed graph node-by-node. Both run on every load. For legitimate
 * inputs near the 256 MB ceiling this adds seconds of CPU; for
 * adversarial input the prescan aborts before parse so the post-walk
 * never fires. We keep both because each catches what the other
 * doesn't.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  E_LLMWIKI_EXPORT_INVALID_SHAPE,
  E_LLMWIKI_EXPORT_NOT_FOUND,
  E_LLMWIKI_EXPORT_OVER_LIMIT,
  LLMWikiBridgeError,
} from "./errors.js";
import { MAX_NESTING_DEPTH, MAX_TOTAL_SIZE_BYTES } from "./limits.js";
import { assertNestingDepthSafe } from "./nesting-guard.js";
import { LLMWikiExportSchema, type LLMWikiExport } from "./schema.js";

export async function loadLLMWikiExport(filePath: string): Promise<LLMWikiExport> {
  await assertExists(filePath);
  const raw = await readWithCap(filePath);
  assertRawDepthSafe(raw, filePath);
  const parsed = parseJsonOrThrow(raw, filePath);
  assertNestingDepthSafe(parsed);
  const result = LLMWikiExportSchema.safeParse(parsed);
  if (!result.success) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_EXPORT_INVALID_SHAPE,
      `Export ${displayPath(filePath)} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/** Throw E_LLMWIKI_EXPORT_NOT_FOUND if the file isn't readable. Doesn't trust the size yet. */
async function assertExists(filePath: string): Promise<void> {
  try {
    await stat(filePath);
  } catch (cause) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_EXPORT_NOT_FOUND,
      `Export not readable at ${displayPath(filePath)}.`,
      { cause },
    );
  }
}

/**
 * Stream the file into memory, aborting the moment the accumulated
 * size exceeds the cap. Replaces the old stat+readFile flow that
 * trusted the metadata-reported size; here the cap is enforced
 * against bytes actually read, so a file growing under us still gets
 * rejected.
 */
async function readWithCap(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const chunks: string[] = [];
    let totalBytes = 0;
    stream.on("data", (chunk: string | Buffer) => {
      const piece = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      totalBytes += Buffer.byteLength(piece, "utf-8");
      if (totalBytes > MAX_TOTAL_SIZE_BYTES) {
        stream.destroy();
        reject(
          new LLMWikiBridgeError(
            E_LLMWIKI_EXPORT_OVER_LIMIT,
            `Export ${displayPath(filePath)} exceeds the ${MAX_TOTAL_SIZE_BYTES}-byte cap.`,
          ),
        );
        return;
      }
      chunks.push(piece);
    });
    stream.on("error", (cause) =>
      reject(
        new LLMWikiBridgeError(
          E_LLMWIKI_EXPORT_NOT_FOUND,
          `Export not readable at ${displayPath(filePath)}.`,
          { cause },
        ),
      ),
    );
    stream.on("end", () => resolve(chunks.join("")));
  });
}

/**
 * Lightweight prescan: track open-brace depth across the raw string,
 * skipping string literals so brackets inside strings don't inflate
 * the count. Aborts before `JSON.parse` allocates anything. Not a
 * full JSON parser — that is `JSON.parse`'s job. This guard exists to
 * reject inputs `JSON.parse` would OOM on.
 */
function assertRawDepthSafe(raw: string, filePath: string): void {
  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
      if (maxDepth > MAX_NESTING_DEPTH) {
        throw new LLMWikiBridgeError(
          E_LLMWIKI_EXPORT_OVER_LIMIT,
          `Export ${displayPath(filePath)} nests deeper than ${MAX_NESTING_DEPTH}.`,
        );
      }
    } else if (ch === "}" || ch === "]") {
      depth--;
    }
  }
}

function parseJsonOrThrow(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_EXPORT_INVALID_SHAPE,
      `Export ${displayPath(filePath)} is not valid JSON.`,
      { cause },
    );
  }
}

/** Show only the basename in user-facing error messages so server filesystem layout doesn't leak. */
function displayPath(filePath: string): string {
  return path.basename(filePath);
}
