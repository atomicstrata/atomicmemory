#!/usr/bin/env node
/**
 * @file CLI entrypoint — `atomicmemory-mcp`. Loads config from the
 *       environment, attaches a stdio transport, and starts the MCP
 *       server. Intended to be invoked by coding-agent plugin manifests
 *       through the package binary, or by source-development workflows
 *       with `node packages/mcp-server/dist/bin.js`.
 */

import { Console } from 'node:console';
import { Writable } from 'node:stream';

type StdoutWrite = (
  chunk: string | Uint8Array,
  encoding?: BufferEncoding,
  callback?: (error?: Error | null) => void,
) => boolean;

function routeConsoleToStderr(): void {
  const stderrConsole = new Console({
    stdout: process.stderr,
    stderr: process.stderr,
  });

  console.log = stderrConsole.log.bind(stderrConsole);
  console.info = stderrConsole.info.bind(stderrConsole);
  console.debug = stderrConsole.debug.bind(stderrConsole);
}

function routeProcessStdoutToStderr(): StdoutWrite {
  const originalWrite = process.stdout.write.bind(process.stdout) as StdoutWrite;

  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown) => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const text =
      typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk).toString(encoding as BufferEncoding | undefined);

    process.stderr.write(text);
    if (typeof done === 'function') {
      queueMicrotask(() => done());
    }
    return true;
  }) as typeof process.stdout.write;

  return originalWrite;
}

function createProtocolStdout(write: StdoutWrite): Writable {
  return new Writable({
    write(chunk: Buffer, encoding, callback) {
      write(chunk, encoding, callback);
    },
  });
}

async function main(): Promise<void> {
  routeConsoleToStderr();
  const protocolStdout = createProtocolStdout(routeProcessStdoutToStderr());

  const [{ StdioServerTransport }, { loadConfigFromEnv }, { buildServer }] =
    await Promise.all([
      import('@modelcontextprotocol/sdk/server/stdio.js'),
      import('./config.js'),
      import('./server.js'),
    ]);

  const config = loadConfigFromEnv();
  const server = await buildServer(config);

  const transport = new StdioServerTransport(process.stdin, protocolStdout);
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[atomicmemory-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
