#!/usr/bin/env node
/**
 * Install the AtomicMemory Langflow components.
 *
 * Langflow discovers components as direct .py files under
 * $LANGFLOW_COMPONENTS_PATH/<category>/<name>.py. This copies the thin entry
 * files (each a local Component subclass) into <target>/atomicmemory/ and then
 * verifies the importable package `atomicmemory_langflow` is present in the
 * Python interpreter Langflow uses (npm cannot pip-install into that venv).
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageDir = dirname(fileURLToPath(import.meta.url));
const ENTRY_FILES = ['chat_memory.py', 'search_context.py', 'store_message.py', 'delete.py'];

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) return printHelp();
  const categoryDir = join(componentsRoot(options), 'atomicmemory');
  installEntries(categoryDir);
  verifyPython(options.python ?? 'python3');
  printNextSteps(categoryDir);
}

function parseArgs(argv) {
  const options = { target: undefined, python: undefined, help: false };
  const args = [...argv];
  const requireValue = (flag) => {
    const value = args.shift();
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--target') options.target = resolve(requireValue('--target'));
    else if (arg === '--python') options.python = requireValue('--python');
    else throw new Error(`Unknown option '${arg}'`);
  }
  return options;
}

function componentsRoot(options) {
  // --target (or LANGFLOW_COMPONENTS_PATH) is the components ROOT; the installer
  // always appends the 'atomicmemory' category dir under it.
  const base = options.target ?? process.env.LANGFLOW_COMPONENTS_PATH;
  if (!base) {
    throw new Error('Set LANGFLOW_COMPONENTS_PATH or pass --target <components-root>.');
  }
  return base;
}

function installEntries(target) {
  mkdirSync(target, { recursive: true });
  for (const file of ENTRY_FILES) {
    copyFileSync(join(packageDir, 'entries', file), join(target, basename(file)));
  }
  console.log(`Copied ${ENTRY_FILES.length} AtomicMemory component(s) to ${target}`);
}

function verifyPython(python) {
  const res = spawnSync(python, ['-c', 'import atomicmemory_langflow'], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(
      `\n[warning] '${python}' cannot import atomicmemory_langflow.\n` +
        `Install it into the SAME environment Langflow runs in:\n` +
        `  ${python} -m pip install atomicmemory-langflow\n`
    );
    process.exitCode = 1;
  } else {
    console.log(`Verified: ${python} can import atomicmemory_langflow.`);
  }
}

function printNextSteps(target) {
  console.log('\nNext:');
  console.log('  export ATOMICMEMORY_API_URL="http://localhost:17350"  # used by your flow inputs');
  console.log(`  # Restart Langflow so it rescans ${dirname(target)}`);
}

function printHelp() {
  console.log(`Usage: atomicmemory-langflow [--target <components-root>] [--python <exe>]

--target (or LANGFLOW_COMPONENTS_PATH) is the components ROOT. Entry files are
copied into <components-root>/atomicmemory/, and 'atomicmemory_langflow' is
verified importable by --python (default python3).`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
