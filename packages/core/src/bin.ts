#!/usr/bin/env node
/**
 * AtomicMemory Core CLI entry point.
 *
 * Keeps npm execution intentionally thin: it applies an explicit local
 * development profile when requested, then delegates to the same server and
 * migration entry points used by source and Docker workflows.
 */

import { fileURLToPath } from 'node:url';

const LOCAL_PROFILE_DEFAULTS = {
  CORE_API_KEY: 'local-dev-key',
  EMBEDDING_DIMENSIONS: '384',
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_PROVIDER: 'transformers',
  LLM_PROVIDER: 'claude-code',
  PORT: '17350',
  RAW_STORAGE_DEPLOYMENT_ENV: 'local',
  RAW_STORAGE_MODE: 'pointer_only',
  STORAGE_KEY_HMAC_SECRET:
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
} as const;

type CommandName = 'start' | 'migrate';
type ProfileName = 'local';

interface ParsedArgs {
  command: CommandName | null;
  help: boolean;
  profile: ProfileName | null;
}

function printHelp(): void {
  console.log(`AtomicMemory Core

Usage:
  atomicmemory-core start [--profile local]
  atomicmemory-core migrate [--profile local]

Commands:
  start      Start the HTTP API server
  migrate    Apply the Postgres/pgvector schema

Profiles:
  local      Fill local-only defaults for port, auth, storage policy,
             transformers embeddings, and Claude Code LLM.

Required:
  DATABASE_URL must point at a reachable Postgres database with pgvector.
`);
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const [commandArg, ...rest] = argv;
  return {
    command: parseCommand(commandArg),
    help: shouldShowHelp(argv, commandArg),
    profile: parseProfile(rest),
  };
}

function parseCommand(value: string | undefined): CommandName | null {
  if (value === 'start' || value === 'migrate') return value;
  return null;
}

function shouldShowHelp(argv: string[], commandArg: string | undefined): boolean {
  return argv.includes('--help') || argv.includes('-h') || !commandArg;
}

function parseProfile(argv: string[]): ProfileName | null {
  const profileIndex = argv.indexOf('--profile');
  if (profileIndex < 0) {
    assertNoUnknownArgs(argv);
    return null;
  }
  const value = argv[profileIndex + 1];
  if (value !== 'local') throw new Error(`Unsupported profile: ${value ?? '<missing>'}`);
  assertNoUnknownArgs([
    ...argv.slice(0, profileIndex),
    ...argv.slice(profileIndex + 2),
  ]);
  return value;
}

function assertNoUnknownArgs(argv: string[]): void {
  const unknown = argv.find((arg) => arg !== '--help' && arg !== '-h');
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
}

function applyLocalProfileDefaults(): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(LOCAL_PROFILE_DEFAULTS)) {
    if (process.env[key]) continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

function assertLocalProfileReady(): void {
  if (process.env.DATABASE_URL) return;
  throw new Error(
    "DATABASE_URL is required. For local testing, start Postgres/pgvector and set " +
      "DATABASE_URL='postgresql://user:pass@host:5432/database'.",
  );
}

async function runCommand(command: CommandName): Promise<void> {
  if (command === 'start') {
    await import('./server.js');
    return;
  }
  await import('./db/migrate.js');
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  if (!parsed.command) throw new Error(`Unknown command: ${argv[0]}`);
  applyProfile(parsed.profile);
  await runCommand(parsed.command);
}

function applyProfile(profile: ProfileName | null): void {
  if (profile !== 'local') return;
  const applied = applyLocalProfileDefaults();
  if (applied.length > 0) {
    console.log(`[cli] Applied local profile defaults: ${applied.join(', ')}`);
  }
  assertLocalProfileReady();
}

function isEntrypoint(): boolean {
  const invokedPath = process.argv[1] ?? '';
  return invokedPath === fileURLToPath(import.meta.url) || invokedPath.endsWith('/atomicmemory-core');
}

if (isEntrypoint()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
