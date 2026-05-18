#!/usr/bin/env node
/**
 * Install the AtomicMemory Hermes provider from the published npm package.
 *
 * Hermes discovers user-installed memory providers as direct children of
 * `$HERMES_HOME/plugins/<name>` (bundled providers live under
 * `plugins/memory/<name>` inside hermes-agent itself, but user-installed
 * plugins are flat under `plugins/`). The npm package already contains the
 * Python provider files, so this installer copies only that managed provider
 * surface into the active Hermes profile without requiring a Git checkout.
 */

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = dirname(fileURLToPath(import.meta.url));

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (options.command !== 'install') {
    throw new Error(`Unknown command '${options.command}'. Expected 'install'.`);
  }
  const target = options.target ?? defaultTarget();
  installProvider(target);
  printNextSteps(target);
}

function parseArgs(argv) {
  const options = { command: 'install', target: undefined, help: false };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift();
  }
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--target') {
      const value = args.shift();
      if (!value) throw new Error('--target requires a path');
      options.target = resolve(value);
      continue;
    }
    throw new Error(`Unknown option '${arg}'`);
  }
  return options;
}

function defaultTarget() {
  const hermesHome = process.env.HERMES_HOME || defaultHermesHome();
  return join(hermesHome, 'plugins', 'atomicmemory');
}

function defaultHermesHome() {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('Set HERMES_HOME or HOME before installing the Hermes provider.');
  }
  return join(home, '.hermes');
}

function installProvider(target) {
  mkdirSync(target, { recursive: true });
  for (const file of providerFiles()) {
    copyFileSync(join(packageDir, file), join(target, basename(file)));
  }
}

function providerFiles() {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  return pkg.files.filter((file) => file.endsWith('.py') || file === 'plugin.yaml' || file === 'README.md');
}

function printNextSteps(target) {
  console.log(`Installed AtomicMemory Hermes provider to ${target}`);
  console.log('');
  console.log('Next:');
  console.log('  export ATOMICMEMORY_API_URL="http://127.0.0.1:3050"');
  console.log('  export ATOMICMEMORY_API_KEY="local-dev-key"');
  console.log('  hermes memory setup');
  console.log('  hermes memory status');
}

function printHelp() {
  console.log(`Usage: atomicmemory-hermes [install] [--target <dir>]

Installs the AtomicMemory Hermes memory provider into:
  $HERMES_HOME/plugins/atomicmemory

When HERMES_HOME is unset, defaults to:
  $HOME/.hermes/plugins/atomicmemory`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
