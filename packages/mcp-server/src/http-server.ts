/**
 * @file Hosted MCP HTTP app — Streamable HTTP + optional legacy SSE.
 *
 * Serves MCP alongside stdio. Every MCP request requires a
 * Bearer project API key; the key is bound to the session's
 * MemoryClient so Cloud REST calls stay per-tenant.
 */

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  AuthUnavailableError,
  createCloudApiKeyValidator,
  hashApiKey,
  requireBearerToken,
  sendUnauthorized,
  UnauthorizedError,
  type ApiKeyValidator,
} from './auth.js';
import type { ServerConfig } from './config.js';
import {
  DEFAULT_HOSTED_HTTP_LIMITS,
  type HostedHttpLimits,
  type HttpListenConfig,
} from './http-listen.js';
import {
  buildServer,
  sessionConfigFromBearer,
  type BuildServerDeps,
} from './server.js';
import {
  keyHashMatches,
  SessionRegistry,
  type AdmitRefusal,
  type SessionEntry,
  type SessionReservation,
} from './session-registry.js';

const MCP_PATHS = ['/mcp', '/sse', '/messages'];

/** Longest interval between idle-session sweeps. */
const MAX_SWEEP_INTERVAL_MS = 60_000;

/** JSON-RPC code the MCP spec pairs with HTTP 404 for an unknown session. */
const SESSION_NOT_FOUND_CODE = -32001;

interface RequestWithKey extends Request {
  mcpApiKey?: string;
}

export interface StartHttpServerOptions {
  /** Base config (apiUrl, provider, scope). apiKey from env is ignored. */
  baseConfig: ServerConfig;
  listen: HttpListenConfig;
  /** Session and key-validation limits; unset fields use the defaults. */
  limits?: Partial<HostedHttpLimits>;
  validateApiKey?: ApiKeyValidator;
  buildDeps?: BuildServerDeps;
  /** Clock override for tests (session idle tracking). */
  now?: () => number;
}

export interface RunningHttpServer {
  app: Express;
  port: number;
  host: string;
  close: () => Promise<void>;
}

/**
 * Start the hosted MCP HTTP listener (health + /mcp + optional SSE).
 */
export async function startHttpServer(
  options: StartHttpServerOptions,
): Promise<RunningHttpServer> {
  const limits: HostedHttpLimits = { ...DEFAULT_HOSTED_HTTP_LIMITS, ...options.limits };
  const validateApiKey =
    options.validateApiKey ??
    createCloudApiKeyValidator({
      timeoutMs: limits.authTimeoutMs,
      cacheTtlMs: limits.authCacheTtlMs,
    });
  const sessions = new SessionRegistry(limits, options.now);
  const app = createApp(options.listen);

  mountHealth(app);
  if (options.listen.allowedHosts) {
    // Scoped to the MCP routes so load balancer health checks, whose Host
    // header is the task address, keep passing.
    app.use(MCP_PATHS, hostHeaderValidation(options.listen.allowedHosts));
  }
  app.use(mcpAuthMiddleware(options.baseConfig.apiUrl, validateApiKey));
  mountStreamableHttp(app, options, sessions);
  if (options.listen.enableSse) {
    mountLegacySse(app, options, sessions);
  }

  const httpServer = await listen(app, options.listen);
  const sweep = startIdleSweep(sessions, limits.sessionIdleTtlMs);
  const address = httpServer.address();
  const boundPort =
    address && typeof address === 'object' ? address.port : options.listen.port;
  return {
    app,
    port: boundPort,
    host: options.listen.host,
    close: () => {
      clearInterval(sweep);
      return closeHttp(httpServer, sessions);
    },
  };
}

/**
 * With an explicit Host allowlist the SDK factory would validate every
 * route, including /healthz, so build the same JSON app and mount the
 * SDK's validation on the MCP routes instead.
 */
function createApp(listenConfig: HttpListenConfig): Express {
  if (!listenConfig.allowedHosts) {
    return createMcpExpressApp({ host: listenConfig.host });
  }
  const app = express();
  app.use(express.json());
  return app;
}

function mountHealth(app: Express): void {
  const body = { ok: true as const };
  app.get('/healthz', (_req, res) => {
    res.status(200).json(body);
  });
  app.get('/health', (_req, res) => {
    res.status(200).json(body);
  });
}

function mcpAuthMiddleware(
  apiUrl: string,
  validateApiKey: ApiKeyValidator,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void authenticateMcpRequest(req, res, next, apiUrl, validateApiKey);
  };
}

async function authenticateMcpRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  apiUrl: string,
  validateApiKey: ApiKeyValidator,
): Promise<void> {
  if (!isMcpPath(req.path)) {
    next();
    return;
  }
  try {
    const apiKey = requireBearerToken(req);
    const ok = await validateApiKey(apiUrl, apiKey);
    if (!ok) {
      sendUnauthorized(res, 'Invalid project API key');
      return;
    }
    (req as RequestWithKey).mcpApiKey = apiKey;
    next();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      sendUnauthorized(res, error.message);
      return;
    }
    // AuthUnavailableError and anything unexpected: validity is unknown,
    // so answer 503 and never open a session.
    if (!res.headersSent) {
      res.status(503).json({
        error: 'auth_unavailable',
        message:
          error instanceof AuthUnavailableError
            ? error.message
            : 'Unable to validate project API key',
      });
    }
  }
}

function isMcpPath(path: string): boolean {
  return MCP_PATHS.includes(path);
}

/**
 * Wrap an async route handler so a rejection is answered (401 for a key
 * mismatch, 500 otherwise) instead of escaping as an unhandled rejection,
 * which would crash the process for every tenant.
 */
function guarded(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((error: unknown) => {
      sendRequestError(res, error);
    });
  };
}

function sendRequestError(res: Response, error: unknown): void {
  if (error instanceof UnauthorizedError) {
    sendUnauthorized(res, error.message);
    return;
  }
  process.stderr.write(
    `[atomicmemory-mcp] request failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  if (res.headersSent) {
    // A stream (SSE) is already open; the only safe signal left is to end it.
    res.end();
    return;
  }
  sendJsonRpcError(res, 500, -32603, 'Internal server error');
}

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function mountStreamableHttp(
  app: Express,
  options: StartHttpServerOptions,
  sessions: SessionRegistry,
): void {
  app.all(
    '/mcp',
    guarded((req, res) => handleStreamableHttp(req, res, options, sessions)),
  );
}

async function handleStreamableHttp(
  req: Request,
  res: Response,
  options: StartHttpServerOptions,
  sessions: SessionRegistry,
): Promise<void> {
  const apiKey = (req as RequestWithKey).mcpApiKey;
  if (!apiKey) {
    sendUnauthorized(res);
    return;
  }

  const sessionId = headerValue(req.headers['mcp-session-id']);
  if (sessionId) {
    // Unknown IDs (e.g. after a restart or idle eviction) get 404 so the
    // client knows to re-initialize, per the Streamable HTTP spec.
    const entry = sessions.get(sessionId);
    if (!entry) {
      sendJsonRpcError(res, 404, SESSION_NOT_FOUND_CODE, 'Session not found');
      return;
    }
    await reuseStreamableSession(sessionId, entry, apiKey, req, res, sessions);
    return;
  }
  if (req.method === 'POST' && isInitializeRequest(req.body)) {
    await openStreamableSession(apiKey, req, res, options, sessions);
    return;
  }
  sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
}

async function reuseStreamableSession(
  sessionId: string,
  entry: SessionEntry,
  apiKey: string,
  req: Request,
  res: Response,
  sessions: SessionRegistry,
): Promise<void> {
  if (!(entry.transport instanceof StreamableHTTPServerTransport)) {
    sendJsonRpcError(
      res,
      400,
      -32000,
      'Bad Request: Session exists but uses a different transport',
    );
    return;
  }
  assertSessionKey(entry.keyHash, apiKey);
  sessions.touch(sessionId);
  await entry.transport.handleRequest(req, res, req.body);
}

async function openStreamableSession(
  apiKey: string,
  req: Request,
  res: Response,
  options: StartHttpServerOptions,
  sessions: SessionRegistry,
): Promise<void> {
  const keyHash = hashApiKey(apiKey);
  const reservation = reserveSession(sessions, keyHash, res);
  if (!reservation) return;

  try {
    const server = await buildServer(
      sessionConfigFromBearer(options.baseConfig, apiKey),
      options.buildDeps,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.add(id, { transport, keyHash, server });
      },
    });
    // SDK Transport.onclose is optional; StreamableHTTP setter accepts undefined.
    await server.connect(transport as unknown as Transport);

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await transport.handleRequest(req, res, req.body);
  } finally {
    reservation.release();
  }
}

function mountLegacySse(
  app: Express,
  options: StartHttpServerOptions,
  sessions: SessionRegistry,
): void {
  app.get(
    '/sse',
    guarded((req, res) => openSseSession(req, res, options, sessions)),
  );
  app.post(
    '/messages',
    guarded((req, res) => handleSseMessage(req, res, sessions)),
  );
}

async function openSseSession(
  req: Request,
  res: Response,
  options: StartHttpServerOptions,
  sessions: SessionRegistry,
): Promise<void> {
  const apiKey = (req as RequestWithKey).mcpApiKey;
  if (!apiKey) {
    sendUnauthorized(res);
    return;
  }

  const keyHash = hashApiKey(apiKey);
  const reservation = reserveSession(sessions, keyHash, res);
  if (!reservation) return;

  try {
    const server = await buildServer(
      sessionConfigFromBearer(options.baseConfig, apiKey),
      options.buildDeps,
    );
    const transport = new SSEServerTransport('/messages', res);
    sessions.add(transport.sessionId, { transport, keyHash, server });
    res.on('close', () => {
      sessions.delete(transport.sessionId);
    });
    await server.connect(transport as unknown as Transport);
  } finally {
    reservation.release();
  }
}

async function handleSseMessage(
  req: Request,
  res: Response,
  sessions: SessionRegistry,
): Promise<void> {
  const apiKey = (req as RequestWithKey).mcpApiKey;
  if (!apiKey) {
    sendUnauthorized(res);
    return;
  }

  const sessionId =
    typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  if (!sessionId) {
    res.status(400).send('Missing sessionId');
    return;
  }
  const entry = sessions.get(sessionId);
  if (!entry) {
    res.status(404).send('Session not found');
    return;
  }
  if (!(entry.transport instanceof SSEServerTransport)) {
    res.status(400).send('No SSE transport found for sessionId');
    return;
  }
  assertSessionKey(entry.keyHash, apiKey);
  sessions.touch(sessionId);
  await entry.transport.handlePostMessage(req, res, req.body);
}

/**
 * Reserve capacity for a new session, answering 429 when a cap is hit.
 */
function reserveSession(
  sessions: SessionRegistry,
  keyHash: Buffer,
  res: Response,
): SessionReservation | null {
  const reservation = sessions.reserve(keyHash);
  if (typeof reservation === 'object') return reservation;
  sendJsonRpcError(res, 429, -32000, sessionLimitMessage(reservation));
  return null;
}

function sessionLimitMessage(refusal: AdmitRefusal): string {
  return refusal === 'key_limit'
    ? 'Too many open MCP sessions for this API key; close idle sessions and retry'
    : 'MCP server session limit reached; retry later';
}

function assertSessionKey(bound: Buffer, presented: string): void {
  if (!keyHashMatches(bound, hashApiKey(presented))) {
    throw new UnauthorizedError('Bearer key does not match MCP session');
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Periodically close sessions idle past the TTL. The timer is unref'd so
 * it never keeps the process alive on its own.
 */
function startIdleSweep(
  sessions: SessionRegistry,
  idleTtlMs: number,
): NodeJS.Timeout {
  const interval = Math.min(MAX_SWEEP_INTERVAL_MS, Math.max(10, Math.floor(idleTtlMs / 2)));
  const timer = setInterval(() => {
    for (const entry of sessions.evictIdle()) {
      void closeSession(entry);
    }
  }, interval);
  timer.unref();
  return timer;
}

async function closeSession(entry: SessionEntry): Promise<void> {
  await entry.transport.close().catch(() => undefined);
  await entry.server.close().catch(() => undefined);
}

function listen(
  app: Express,
  listenConfig: HttpListenConfig,
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(listenConfig.port, listenConfig.host, () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

async function closeHttp(
  httpServer: HttpServer,
  sessions: SessionRegistry,
): Promise<void> {
  for (const entry of sessions.drain()) {
    await closeSession(entry);
  }
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}
