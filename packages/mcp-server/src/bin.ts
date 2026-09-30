#!/usr/bin/env node
/**
 * @file CLI entrypoint — `atomicmemory-mcp`.
 *
 * Default transport is stdio for local agents / plugin manifests. Stdio
 * resolves the provider URL as explicit `ATOMICMEMORY_API_URL`, else Cloud
 * when `ATOMICMEMORY_API_KEY` is set, else local Core at
 * `http://127.0.0.1:17350`. Pass `--http` or set
 * `ATOMICMEMORY_MCP_TRANSPORT=http` for hosted Streamable HTTP + Bearer auth;
 * HTTP still requires an explicit API URL.
 */

import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { resolveTransport, loadHostedHttpLimits, loadHttpListenConfig } from './http-listen.js';

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

async function runStdio(): Promise<void> {
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

async function runHttp(): Promise<void> {
  const [{ loadHostedHttpConfigFromEnv }, { startHttpServer }] = await Promise.all([
    import('./config.js'),
    import('./http-server.js'),
  ]);

  const hostedBase = loadHostedHttpConfigFromEnv();
  const listen = loadHttpListenConfig();
  const limits = loadHostedHttpLimits();
  const running = await startHttpServer({ baseConfig: hostedBase, listen, limits });

  process.stderr.write(
    `[atomicmemory-mcp] http listening on ${running.host}:${running.port} ` +
      `(mcp=/mcp health=/healthz` +
      `${listen.enableSse ? ' sse=/sse' : ''}` +
      `${listen.allowedHosts ? ` allowed-hosts=${listen.allowedHosts.join(',')}` : ''})\n`,
  );

  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

async function main(): Promise<void> {
  const transport = resolveTransport(process.argv.slice(2), process.env);
  if (transport === 'http') {
    await runHttp();
    return;
  }
  await runStdio();
}

main().catch((err) => {
  process.stderr.write(`[atomicmemory-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
