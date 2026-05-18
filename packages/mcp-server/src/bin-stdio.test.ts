/**
 * @file Regression test for stdio transport hygiene. MCP stdio stdout
 *       must contain JSON-RPC only; dependency startup logs belong on
 *       stderr or tool registration can fail in hosts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

interface ToolsListResponse {
  id: number;
  result: { tools: Array<{ name: string }> };
}

test('bin stdout contains only JSON-RPC and exposes memory tools', async () => {
  const {
    ATOMICMEMORY_PROVIDER,
    ATOMICMEMORY_SCOPE_USER,
    ...env
  } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts'], {
    cwd: process.cwd(),
    env: {
      ...env,
      USER: 'stdio-smoke',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const listResponse = waitForToolsListResponse(child);

  try {
    writeJsonLine(child, initializeRequest());
    writeJsonLine(child, initializedNotification());
    writeJsonLine(child, toolsListRequest());

    const response = await listResponse;
    assertHasTool(response, 'memory_ingest', stderr);
    assertHasTool(response, 'memory_search', stderr);
    assertHasTool(response, 'memory_package', stderr);
  } finally {
    child.kill('SIGTERM');
  }
});

function waitForToolsListResponse(
  child: ChildProcessWithoutNullStreams,
): Promise<ToolsListResponse> {
  let stdout = '';
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const index = stdout.indexOf('\n');
        if (index === -1) return;
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        if (line) handleStdoutLine(line, cleanup, resolve, fail);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(new Error(`MCP child exited before tools/list response: ${code ?? signal}`));
    const onError = (error: Error) => fail(error);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function handleStdoutLine(
  line: string,
  cleanup: () => void,
  resolve: (response: ToolsListResponse) => void,
  reject: (error: Error) => void,
): void {
  let message: unknown;
  try {
    message = parseJsonLine(line);
  } catch (error) {
    reject(error as Error);
    return;
  }

  if (isToolsListResponse(message)) {
    cleanup();
    resolve(message);
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`MCP stdout contained non-JSON output: ${line}`, {
      cause: error,
    });
  }
}

function writeJsonLine(
  child: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'atomicmemory-stdio-test', version: '0.0.0' },
    },
  };
}

function initializedNotification(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  };
}

function toolsListRequest(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  };
}

function assertHasTool(
  response: ToolsListResponse,
  name: string,
  stderr: string,
): void {
  assert.ok(
    response.result.tools.some((tool) => tool.name === name),
    `${name} missing from tools/list; stderr=${stderr}`,
  );
}

function isToolsListResponse(message: unknown): message is ToolsListResponse {
  return (
    isRecord(message) &&
    message.id === 2 &&
    isRecord(message.result) &&
    Array.isArray(message.result.tools)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
