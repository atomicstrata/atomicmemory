#!/usr/bin/env tsx
/**
 * scripts/cleanup-meta-facts.ts
 *
 * Retroactive cleanup of meta-fact pollution in existing `memories` rows.
 *
 * The extraction-time filter added in this branch stops *new* meta-facts
 * from entering the store. Deployments that ingested data before the
 * filter shipped (for example, early Filecoin test deployments) still have polluted
 * rows that outrank durable user facts on similarity search. This
 * script identifies and soft-deletes those rows using the same pattern
 * set as the runtime filter, so behaviour is consistent post-cleanup.
 *
 * Safety contract:
 *   - Defaults to --dry-run. Apply mode requires explicit --apply.
 *   - Soft-delete only (sets deleted_at = NOW()). No hard delete; the
 *     audit log is the source of truth and the change is reversible by
 *     clearing deleted_at on the same ids.
 *   - Idempotent. Already-deleted rows are skipped.
 *   - Optional --user-id scope for surgical runs.
 *   - Writes a JSONL audit log to ./cleanup-meta-facts-<ts>.jsonl so
 *     operators have a verifiable record of every dropped row.
 *
 * Usage:
 *   pnpm dotenv -e .env -- tsx scripts/cleanup-meta-facts.ts --dry-run
 *   pnpm dotenv -e .env -- tsx scripts/cleanup-meta-facts.ts --apply
 *   pnpm dotenv -e .env -- tsx scripts/cleanup-meta-facts.ts --apply --user-id <uid>
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pool } from '../src/db/pool.js';
import { getMetaFactDropStats, isMetaFactStatement } from '../src/services/meta-fact-filter.js';

interface CliOptions {
  apply: boolean;
  userId: string | null;
  batchSize: number;
  limit: number | null;
  out: string;
}

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'user-id': { type: 'string' },
      'batch-size': { type: 'string', default: '500' },
      limit: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(`Usage: cleanup-meta-facts.ts [options]
  --dry-run         Default. Report rows that would be dropped.
  --apply           Soft-delete matching rows.
  --user-id <uid>   Restrict to a single user_id.
  --batch-size <n>  Rows per scan batch (default 500).
  --limit <n>       Stop after scanning n rows (testing aid).
  --out <path>      Audit log path (default ./cleanup-meta-facts-<ts>.jsonl).
  --help, -h        Show this message.
`);
    process.exit(0);
  }

  const apply = Boolean(values.apply);
  const userId = (values['user-id'] as string | undefined) ?? null;
  const batchSize = Number(values['batch-size']);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`--batch-size must be a positive integer, got "${values['batch-size']}"`);
  }
  const limit = values.limit ? Number(values.limit) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive integer, got "${values.limit}"`);
  }
  const out =
    (values.out as string | undefined) ??
    path.resolve(process.cwd(), `cleanup-meta-facts-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

  return { apply, userId, batchSize, limit, out };
}

interface MemoryRow {
  id: string;
  user_id: string;
  content: string;
  created_at: Date;
}

async function* scanMemories(opts: CliOptions): AsyncGenerator<MemoryRow[]> {
  let cursor: string | null = null;
  let scanned = 0;
  while (true) {
    const params: unknown[] = [];
    const whereParts: string[] = ['deleted_at IS NULL'];
    if (opts.userId) {
      params.push(opts.userId);
      whereParts.push(`user_id = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor);
      whereParts.push(`id > $${params.length}`);
    }
    params.push(opts.batchSize);
    const sql = `
      SELECT id, user_id, content, created_at
      FROM memories
      WHERE ${whereParts.join(' AND ')}
      ORDER BY id ASC
      LIMIT $${params.length}
    `;
    const result = await pool.query<MemoryRow>(sql, params);
    if (result.rows.length === 0) return;
    yield result.rows;
    cursor = result.rows[result.rows.length - 1].id;
    scanned += result.rows.length;
    if (opts.limit !== null && scanned >= opts.limit) return;
  }
}

async function softDeleteIds(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await pool.query(
    `UPDATE memories SET deleted_at = NOW()
     WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids],
  );
  return result.rowCount ?? 0;
}

interface DropRecord {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
  dropped_at: string;
  mode: 'dry-run' | 'apply';
}

async function main(): Promise<void> {
  const opts = parseCliOptions();
  const mode: 'dry-run' | 'apply' = opts.apply ? 'apply' : 'dry-run';
  process.stdout.write(`[cleanup] mode=${mode} user_id=${opts.userId ?? 'all'} batch_size=${opts.batchSize} limit=${opts.limit ?? '∞'}\n`);
  process.stdout.write(`[cleanup] audit log: ${opts.out}\n`);

  const fd = fs.openSync(opts.out, 'a');
  let scanned = 0;
  let matched = 0;
  let softDeleted = 0;
  const startedAt = Date.now();

  try {
    for await (const batch of scanMemories(opts)) {
      scanned += batch.length;
      const matches = batch.filter((r) => isMetaFactStatement(r.content));
      matched += matches.length;
      for (const row of matches) {
        const record: DropRecord = {
          id: row.id,
          user_id: row.user_id,
          content: row.content,
          created_at: new Date(row.created_at).toISOString(),
          dropped_at: new Date().toISOString(),
          mode,
        };
        fs.writeSync(fd, JSON.stringify(record) + '\n');
      }
      if (opts.apply && matches.length > 0) {
        softDeleted += await softDeleteIds(matches.map((m) => m.id));
      }
      if (scanned % (opts.batchSize * 10) === 0) {
        process.stdout.write(`[cleanup] scanned=${scanned} matched=${matched}${opts.apply ? ` soft_deleted=${softDeleted}` : ''}\n`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`\n[cleanup] DONE\n`);
  process.stdout.write(`[cleanup] scanned     ${scanned}\n`);
  process.stdout.write(`[cleanup] matched     ${matched}  (${scanned ? ((matched / scanned) * 100).toFixed(2) : '0.00'}%)\n`);
  if (opts.apply) {
    process.stdout.write(`[cleanup] soft-deleted ${softDeleted}\n`);
    if (softDeleted !== matched) {
      process.stdout.write(`[cleanup] WARNING: matched ${matched} but soft-deleted ${softDeleted} — some rows raced with concurrent deletes\n`);
    }
  } else {
    process.stdout.write(`[cleanup] (dry-run; nothing deleted. Pass --apply to soft-delete.)\n`);
  }
  process.stdout.write(`[cleanup] wall=${wallSeconds}s\n`);
  process.stdout.write(`[cleanup] audit log: ${opts.out}\n`);

  await pool.end();
}

main().catch((err) => {
  process.stderr.write(`[cleanup] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
