/**
 * Namespace-Aware Retrieval — hierarchical scope narrowing for memories.
 *
 * Adds project/topic/scope-aware retrieval as a pre-filter before vector
 * search. Memories are tagged with a slash-separated namespace path
 * (e.g., "project/atomicmem/docs", "user/preferences/editor") and
 * retrieval can be scoped to a namespace prefix.
 *
 * Namespace hierarchy (Phase 2 Canonical Taxonomy):
 *   - "user/preferences/*"
 *   - "user/memories/*"
 *   - "project/{project}/docs/*"
 *   - "project/{project}/decisions/*"
 *   - "project/{project}/tasks/*"
 *   - "agent/{agent}/skills/*"
 *   - "agent/{agent}/task-memories/*"
 *   - "workspace/{workspace}/shared/*"
 *
 * This implements Phase 2's "Canonical Namespaces" from the
 * OpenViking integration design (2026-03-20).
 */

import { llm } from './llm.js';

/** A slash-separated namespace path. */
export type Namespace = string;

/**
 * Parse a namespace string into its hierarchical segments.
 * "project/atomicmem/docs" → ["project", "atomicmem", "docs"]
 */
export function parseNamespace(ns: string): string[] {
  if (!ns || ns.trim() === '') return [];
  // Support both dot and slash during transition
  const delimiter = ns.includes('/') ? '/' : '.';
  return ns.split(delimiter).filter(Boolean);
}

/**
 * Return all ancestor scopes from root to leaf.
 * "project/atomicmem/docs" → ["project", "project/atomicmem", "project/atomicmem/docs"]
 */
export function getAncestorScopes(ns: string): string[] {
  const segments = parseNamespace(ns);
  return segments.map((_, index) => segments.slice(0, index + 1).join(ns.includes('/') ? '/' : '.'));
}

/**
 * Check if a memory's namespace matches a query scope.
 * A scope matches if the memory's namespace starts with the scope prefix.
 */
export function isInScope(
  memoryNamespace: string | null,
  queryScope: string | null,
): boolean {
  if (queryScope === null || queryScope === '') return true;
  if (memoryNamespace === null || memoryNamespace === '') return true;

  const scopeSegments = parseNamespace(queryScope);
  const memorySegments = parseNamespace(memoryNamespace);

  if (memorySegments.length < scopeSegments.length) return false;

  for (let i = 0; i < scopeSegments.length; i++) {
    if (memorySegments[i].toLowerCase() !== scopeSegments[i].toLowerCase()) return false;
  }
  return true;
}

/**
 * Build a SQL WHERE clause for namespace prefix matching.
 * Uses LIKE with escaped delimiters for prefix matching.
 */
export function buildNamespaceClause(
  scope: string | null,
  paramOffset: number,
): { clause: string; params: unknown[] } | null {
  if (!scope || scope.trim() === '') return null;

  const escaped = scope.replace(/[%_\\]/g, '\\$&');
  // Support both dot and slash prefix matching
  const delimiter = scope.includes('/') ? '/' : '.';

  return {
    clause: `(m.namespace IS NULL OR m.namespace = $${paramOffset + 1} OR m.namespace LIKE $${paramOffset + 2})`,
    params: [scope, `${escaped}${delimiter}%`],
  };
}

const CLASSIFICATION_PROMPT = `You are a memory classifier. Categorize the given memory into the most appropriate canonical namespace.

TAXONOMY:
- user/preferences: Likes, dislikes, editor settings, UI preferences
- user/memories: Personal facts, life events, non-technical context
- project/{name}/docs: Documentation, architectural plans, guides
- project/{name}/decisions: Key technical or product decisions made
- project/{name}/tasks: Task progress, TODOs, bugs
- agent/{name}/skills: Capability descriptions, tool usage patterns
- agent/{name}/task-memories: Private working memory for specific tasks
- workspace/shared: General knowledge or facts shared across all agents

RULES:
- Respond ONLY with the namespace path (e.g. "project/atomicmem/decisions").
- Replace {name} with the actual project or agent name found in context.
- Use lowercase and slashes.
- If unsure, default to "user/memories".

MEMORY:
{{content}}

SOURCE SITE:
{{sourceSite}}

KEYWORDS:
{{keywords}}`;

/**
 * Use LLM to classify a memory into the canonical taxonomy.
 */
export async function classifyNamespace(
  content: string,
  sourceSite: string,
  keywords: string[],
): Promise<string> {
  const prompt = CLASSIFICATION_PROMPT
    .replace('{{content}}', content)
    .replace('{{sourceSite}}', sourceSite)
    .replace('{{keywords}}', keywords.join(', '));

  const response = await llm.chat([
    { role: 'system', content: 'You are a precise classification engine.' },
    { role: 'user', content: prompt },
  ], { temperature: 0, maxTokens: 50 });

  return response.trim().toLowerCase();
}

/**
 * Extract a legacy namespace suggestion from memory content.
 * Retained for fallback and non-LLM paths.
 */
export function inferNamespace(
  content: string,
  sourceSite: string,
  keywords: string[],
): string | null {
  const lower = content.toLowerCase();
  const kwLower = keywords.map((k) => k.toLowerCase());

  if (sourceSite && sourceSite !== 'unknown') {
    const site = sourceSite.replace(/[^a-z0-9]/gi, '/').toLowerCase();
    return `site/${site}`;
  }

  for (const kw of kwLower) {
    if (PROJECT_INDICATORS.some((p) => kw.includes(p))) {
      const projectName = extractProjectName(lower, kwLower);
      if (projectName) return `project/${projectName}/docs`;
    }
  }

  for (const [category, terms] of Object.entries(TOPIC_INDICATORS)) {
    if (terms.some((t) => lower.includes(t) || kwLower.includes(t))) {
      return `topic/${category}`;
    }
  }

  return null;
}

const PROJECT_INDICATORS = ['project', 'repo', 'repository', 'codebase', 'workspace'];

const TOPIC_INDICATORS: Record<string, string[]> = {
  databases: ['postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'database', 'sql', 'nosql'],
  frontend: ['react', 'vue', 'angular', 'css', 'html', 'ui', 'ux', 'frontend'],
  backend: ['api', 'server', 'express', 'fastapi', 'django', 'backend', 'endpoint'],
  infrastructure: ['docker', 'kubernetes', 'aws', 'gcp', 'azure', 'terraform', 'ci/cd', 'deploy'],
  testing: ['test', 'testing', 'vitest', 'jest', 'playwright', 'e2e', 'unit test'],
  security: ['auth', 'authentication', 'encryption', 'security', 'oauth', 'jwt'],
};

/**
 * Derive a namespace for a composite from the namespaces of its member atomics.
 * Returns the most common non-null namespace. If all members are null, returns null.
 */
export function deriveMajorityNamespace(memberNamespaces: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const ns of memberNamespaces) {
    if (ns === null) continue;
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let best: string | null = null;
  let bestCount = 0;
  for (const [ns, count] of counts) {
    if (count > bestCount) {
      best = ns;
      bestCount = count;
    }
  }
  return best;
}

function extractProjectName(content: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    if (!PROJECT_INDICATORS.includes(kw) && kw.length > 2 && /^[a-z0-9-]+$/.test(kw)) {
      return kw;
    }
  }
  return null;
}
