/**
 * @file Static-analysis drift guard for `RESERVED_METADATA_KEYS`.
 *
 * Walks every `.ts` file under `src/` (excluding tests and schemas)
 * with the TypeScript compiler API, extracts every metadata key
 * the source either reads or writes, and asserts each one is in
 * `RESERVED_METADATA_KEYS`.
 *
 * Why this exists:
 * `IngestBodySchema` rejects caller-supplied metadata containing
 * any reserved key. The set lives in `src/db/repository-types.ts`
 * and any developer adding a new internal `metadata.<key>`
 * access (or `metadata: { <key>: ... }` write) must keep that
 * set in lockstep — otherwise the new key becomes spoofable from
 * outside. Manually remembering to update a list rots; this test
 * is the forcing function.
 *
 * Three node patterns covered:
 *
 *  1. PropertyAccessExpression where `.expression` is either the
 *     identifier `metadata` directly OR another PropertyAccessExpression
 *     ending in `.metadata` (covers `metadata.X`, `record.metadata.X`,
 *     `memory.metadata.X` etc).
 *  2. ElementAccessExpression with the same expression-side
 *     constraint AND a string literal index (covers `metadata["X"]`).
 *  3. PropertyAssignment whose `.name` is the identifier `metadata`
 *     AND `.initializer` is an ObjectLiteralExpression (covers
 *     `metadata: { X: ..., Y: ... }` writes — the round-4 fix; many
 *     reserved keys appear only as object-literal writes, never as
 *     reads).
 *
 * Identifier and string-literal property keys are both captured;
 * computed-property names and numeric-literal keys are skipped
 * (dynamic / not relevant for metadata key names).
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { RESERVED_METADATA_KEYS } from '../db/repository-types';

const SRC_ROOT = path.resolve(__dirname, '..');
// `storage/` adapters use the property name `metadata` for raw-content
// blob metadata (RawContentMetadata: contentLength/contentType/etc).
// That's a separate namespace from the memory `metadata` JSONB field
// this test guards — caller input never reaches it, so it can't spoof
// reserved keys. Skipping the directory keeps the heuristic from
// flagging these unrelated property names.
const SKIP_DIRS = new Set(['__tests__', 'schemas', 'storage']);

function* walkTs(root: string): Generator<string> {
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkTs(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      yield full;
    }
  }
}

function isMetadataExpression(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'metadata') return true;
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'metadata') return true;
  return false;
}

/** Pattern 1: `<expr>.metadata.X` (incl. aliased `record.metadata.X`). */
function tryExtractPropertyAccess(node: ts.Node, into: Set<string>): void {
  if (!ts.isPropertyAccessExpression(node)) return;
  if (!isMetadataExpression(node.expression)) return;
  into.add(node.name.text);
}

/** Pattern 2: `<expr>.metadata["X"]` with a string-literal index. */
function tryExtractElementAccess(node: ts.Node, into: Set<string>): void {
  if (!ts.isElementAccessExpression(node)) return;
  if (!isMetadataExpression(node.expression)) return;
  if (!ts.isStringLiteral(node.argumentExpression)) return;
  into.add(node.argumentExpression.text);
}

/**
 * Pattern 3 helper: capture the property keys of an object-literal
 * `metadata: { X: ..., "Y": ... }` write. Identifier and string-literal
 * keys are both captured; ComputedPropertyName / NumericLiteral keys
 * are skipped (dynamic / not relevant for metadata key names).
 */
function captureLiteralWriteKeys(
  literal: ts.ObjectLiteralExpression,
  into: Set<string>,
): void {
  for (const prop of literal.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
      into.add(prop.name.text);
    }
  }
}

/** Pattern 3: `metadata: { X: ..., "Y": ... }` object-literal writes. */
function tryExtractLiteralWrite(node: ts.Node, into: Set<string>): void {
  if (!ts.isPropertyAssignment(node)) return;
  if (!ts.isIdentifier(node.name) || node.name.text !== 'metadata') return;
  if (!ts.isObjectLiteralExpression(node.initializer)) return;
  captureLiteralWriteKeys(node.initializer, into);
}

function collectKeys(sourceFile: ts.SourceFile, into: Set<string>): void {
  function visit(node: ts.Node): void {
    tryExtractPropertyAccess(node, into);
    tryExtractElementAccess(node, into);
    tryExtractLiteralWrite(node, into);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

describe('RESERVED_METADATA_KEYS — static-analysis drift guard', () => {
  it('every metadata key seen under src/ (read or write) is reserved', () => {
    const seen = new Set<string>();
    for (const file of walkTs(SRC_ROOT)) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, 'utf-8'),
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
      );
      collectKeys(sf, seen);
    }
    const unreserved = [...seen].filter(k => !RESERVED_METADATA_KEYS.has(k)).sort();
    expect(
      unreserved,
      `unreserved metadata keys seen in src/: ${unreserved.join(', ')}. ` +
        'Add them to RESERVED_METADATA_KEYS in src/db/repository-types.ts ' +
        'or, if a key is genuinely caller-controlled, add the file to ' +
        'SKIP_DIRS in this test.',
    ).toEqual([]);
  });
});
