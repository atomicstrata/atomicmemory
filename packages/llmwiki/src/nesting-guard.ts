/**
 * Defense-in-depth walker that runs BEFORE Zod validation.
 *
 * Two invariants enforced in one pass:
 *
 *   1. **Nesting depth** ≤ `MAX_NESTING_DEPTH`. Zod has no built-in
 *      depth cap. Without this guard, a hostile export could nest
 *      arrays/objects pathologically — the parser tolerates it but
 *      later schema traversal blows the stack.
 *
 *   2. **Per-string size** ≤ `MAX_BODY_LENGTH`. The schema's
 *      per-field length caps only apply to KNOWN fields; we use
 *      `.passthrough()` on every schema object so unknown advisory
 *      fields survive forward-compat-style. Without this walker, a
 *      hostile export could ship `evilField: "<200 MB string>"` and
 *      pass shape validation. By capping every string value
 *      reachable from the root (known or not), the size guarantee in
 *      `limits.ts` holds for passthrough fields too. We use
 *      `MAX_BODY_LENGTH` (1 MB) as the per-value ceiling — it's the
 *      largest legitimate string in the contract (page body), so a
 *      tighter cap would reject valid known fields.
 *
 * Iterative walk, not recursive — recursion itself would defeat the
 * point of a depth guard.
 */

import { MAX_BODY_LENGTH, MAX_NESTING_DEPTH } from "./limits.js";
import { E_LLMWIKI_EXPORT_OVER_LIMIT, LLMWikiBridgeError } from "./errors.js";

interface DepthFrame {
  node: unknown;
  depth: number;
}

export function assertNestingDepthSafe(root: unknown): void {
  const stack: DepthFrame[] = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_NESTING_DEPTH) {
      throw new LLMWikiBridgeError(
        E_LLMWIKI_EXPORT_OVER_LIMIT,
        `Export nesting depth exceeds ${MAX_NESTING_DEPTH}.`,
      );
    }
    assertStringSizeSafe(node);
    pushChildren(node, depth, stack);
  }
}

function assertStringSizeSafe(node: unknown): void {
  if (typeof node !== "string") return;
  if (node.length > MAX_BODY_LENGTH) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_EXPORT_OVER_LIMIT,
      `Export contains a string value of ${node.length} chars; per-value cap is ${MAX_BODY_LENGTH}.`,
    );
  }
}

function pushChildren(node: unknown, depth: number, stack: DepthFrame[]): void {
  if (Array.isArray(node)) {
    for (const child of node) stack.push({ node: child, depth: depth + 1 });
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const child of Object.values(node as Record<string, unknown>)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
}
