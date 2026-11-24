/** Local HTTP fixture with explicit request-arrival and connection-close handshakes. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

/** Captured request after its body has reached the HTTP server. */
export interface CapturedRequest {
  path: string | undefined;
  body: string;
  closed: Promise<void>;
}

/** Running server and explicit lifecycle handshakes for a request-boundary test. */
export interface RequestServer {
  apiUrl: string;
  arrived: Promise<CapturedRequest>;
  requestCount: () => number;
  stop: () => Promise<void>;
}

type ResponseFixture =
  | { status: number; body: unknown }
  | { status: number; bodyText: string }
  | { status: number; partialBody: string };

/** Start a real server that either holds a request open or returns a JSON fixture. */
export async function startRequestServer(
  response?: ResponseFixture,
): Promise<RequestServer> {
  let capture!: (request: CapturedRequest) => void;
  let count = 0;
  const arrived = new Promise<CapturedRequest>((resolve) => {
    capture = resolve;
  });
  const server = createServer((request, reply) => {
    count++;
    void captureRequest(request, reply, capture).then(() => {
      if (response) sendResponse(reply, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP server address');
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    arrived,
    requestCount: () => count,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

function sendResponse(reply: ServerResponse, response: ResponseFixture): void {
  reply.writeHead(response.status, { 'Content-Type': 'application/json' });
  if ('partialBody' in response) reply.write(response.partialBody);
  else if ('bodyText' in response) reply.end(response.bodyText);
  else reply.end(JSON.stringify(response.body));
}

async function captureRequest(
  request: IncomingMessage,
  reply: ServerResponse,
  capture: (request: CapturedRequest) => void,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    reply.on('close', resolve);
  });
  let body = '';
  for await (const chunk of request) body += String(chunk);
  capture({ path: request.url, body, closed });
}
