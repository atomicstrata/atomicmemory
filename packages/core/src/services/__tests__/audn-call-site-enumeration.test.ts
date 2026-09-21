/**
 * Ensures every production resolveAUDN / cachedResolveAUDN call passes promptVariant.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(__dirname, '..');
const CALL_RE = /\b(cachedResolveAUDN|resolveAUDN)\(/g;

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      results.push(full);
    }
  }
  return results;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

function countTopLevelCommas(callSnippet: string): number {
  const open = callSnippet.indexOf('(');
  let depth = 0;
  let commas = 0;
  for (const char of callSnippet.slice(open)) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 1) commas += 1;
  }
  return commas;
}

function isAudnFunctionDefinition(prefix: string): boolean {
  return /function\s+\w*$/.test(prefix) || prefix.includes('export async function');
}

function extractBalancedCall(source: string, startIndex: number): string {
  let depth = 0;
  for (let end = startIndex; end < source.length; end++) {
    const char = source[end]!;
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, end + 1);
    }
  }
  return source.slice(startIndex);
}

function findUnderSpecifiedAudnCalls(source: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(CALL_RE)) {
    const index = match.index ?? 0;
    const prefix = source.slice(Math.max(0, index - 40), index);
    if (isAudnFunctionDefinition(prefix)) continue;

    const snippet = extractBalancedCall(source, index);
    if (countTopLevelCommas(snippet) < 2) {
      offenders.push(snippet.replace(/\s+/g, ' ').trim());
    }
  }
  return offenders;
}

describe('AUDN call-site enumeration', () => {
  it('requires promptVariant on every non-test resolveAUDN / cachedResolveAUDN call', () => {
    const offenders: string[] = [];
    for (const filePath of collectTsFiles(SERVICES)) {
      const source = stripComments(readFileSync(filePath, 'utf-8'));
      for (const snippet of findUnderSpecifiedAudnCalls(source)) {
        offenders.push(`${filePath}: ${snippet}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
