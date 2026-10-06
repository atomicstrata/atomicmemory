/** Compile selected Markdown TypeScript examples against the actual workspace packages. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'package.json'));

function selectedExamples(args) {
  const [file, flag, selection] = args;
  if (!file || args.length > 3 || (flag && flag !== '--blocks') || (flag && !selection)) {
    throw new Error('Usage: check-doc-examples.mjs <markdown-file> [--blocks 0,1,2]');
  }
  const source = readFileSync(resolve(file), 'utf8');
  const blocks = [...source.matchAll(/```(?:ts|typescript)\n([\s\S]*?)\n```/g)].map(match => match[1]);
  if (blocks.length === 0) throw new Error('No TypeScript examples found.');
  const indexes = selection ? selection.split(',').map(value => {
    if (!/^\d+$/.test(value)) throw new Error('Block indexes must be nonnegative integers.');
    return Number(value);
  }) : blocks.map((_, index) => index);
  return indexes.map(index => {
    const block = blocks[index];
    if (block === undefined) throw new Error(`TypeScript block ${index} does not exist.`);
    return block;
  }).join('\n\n');
}

function compileExamples(source) {
  const temporary = mkdtempSync(join(root, '.docs-check-'));
  try {
    writeFileSync(join(temporary, 'examples.ts'), `${source}\nexport {};\n`);
    writeFileSync(join(temporary, 'tsconfig.json'), JSON.stringify({
      extends: '../tsconfig.json', include: ['examples.ts'],
    }));
    const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
      '--project', join(temporary, 'tsconfig.json')], { stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  process.exitCode = compileExamples(selectedExamples(process.argv.slice(2)));
  if (process.exitCode === 0) process.stdout.write('Documentation examples compile against the workspace packages.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Documentation check failed.'}\n`);
  process.exitCode = 1;
}
