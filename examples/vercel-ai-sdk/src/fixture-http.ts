/** Local HTTP contract fixture, not the AtomicMemory engine or hosted Cloud. */
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';

const ingestSchema = z.object({ user_id: z.string(), conversation: z.string() });
const searchSchema = z.object({ user_id: z.string(), query: z.string() });
type Fact = { id: string; content: string; version: number };
type FixtureState = { facts: Map<string, Fact>; nextId: number };

/** The fixture's explicit endpoint and asynchronous cleanup. */
export interface LocalFixture {
  apiUrl: string;
  close(): Promise<void>;
}

/** Start an authenticated, per-user synthetic fixture on an available loopback port. */
export async function startLocalFixture(): Promise<LocalFixture> {
  const state: FixtureState = { facts: new Map(), nextId: 1 };
  const server = createServer((request, response) => {
    void handleRequest(request, response, state).catch(() => {
      writeJson(response, 500, { error: 'fixture_request_failed' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no TCP address.');
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function handleRequest(
  request: IncomingMessage, response: ServerResponse, state: FixtureState,
): Promise<void> {
  if (request.method !== 'POST') return writeJson(response, 405, { error: 'method_not_allowed' });
  if (request.headers.authorization !== 'Bearer local-demo-key') {
    return writeJson(response, 401, { error: 'invalid_fixture_key' });
  }
  const body = await readJson(request);
  switch (request.url) {
    case '/v1/memories/ingest':
      return writeJson(response, 200, ingestFact(state, ingestSchema.parse(body)));
    case '/v1/memories/search/fast':
      return writeJson(response, 200, searchFact(state, searchSchema.parse(body)));
    default:
      return writeJson(response, 404, { error: 'unknown_fixture_route' });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function ingestFact(state: FixtureState, input: z.infer<typeof ingestSchema>): object {
  const previous = state.facts.get(input.user_id);
  const fact = {
    id: previous?.id ?? `fixture-fact-${state.nextId++}`,
    content: input.conversation,
    version: (previous?.version ?? 0) + 1,
  };
  state.facts.set(input.user_id, fact);
  return {
    episode_id: `fixture-episode-${fact.version}`,
    facts_extracted: 1,
    memories_stored: previous ? 0 : 1,
    memories_updated: previous ? 1 : 0,
    memories_deleted: 0,
    memories_skipped: 0,
    stored_memory_ids: previous ? [] : [fact.id],
    updated_memory_ids: previous ? [fact.id] : [],
    links_created: 0,
    composites_created: 0,
  };
}

function searchFact(state: FixtureState, input: z.infer<typeof searchSchema>): object {
  const fact = state.facts.get(input.user_id);
  return {
    memories: fact ? [{
      id: fact.id,
      content: fact.content,
      ranking_score: 1.7,
      semantic_similarity: 0.9,
      relevance: 0.8,
      version_id: `fixture-version-${fact.version}`,
      observed_at: '2026-10-02T00:00:00.000Z',
      created_at: '2026-10-02T00:00:00.000Z',
    }] : [],
    count: fact ? 1 : 0,
    retrieval: {
      embedding_provider: 'fixture',
      embedding_model: 'synthetic-fixture-model',
      embedding_model_version: '1',
      embedding_dimensions: 3,
      query_text: input.query,
      candidate_ids: fact ? [fact.id] : [],
      trace_id: 'fixture-search-trace',
    },
  };
}

function writeJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
