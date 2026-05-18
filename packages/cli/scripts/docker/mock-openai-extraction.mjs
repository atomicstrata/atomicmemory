#!/usr/bin/env node
/**
 * @file Hermetic mock OpenAI-compatible chat-completions server used
 * exclusively by `pnpm -C packages/cli test:backend:docker`.
 *
 * Why this exists: atomicmemory-core's `/v1/memories/ingest` calls
 * `extractFacts` which always invokes the configured LLM. The core
 * `docker-compose.smoke.yml` overlay sets a dummy OpenAI key, which
 * is fine for core's own smoke test (it deliberately uses
 * `/v1/memories/ingest/quick` to skip extraction) but breaks any
 * consumer — including the CLI backend suite — that exercises the
 * full ingest path.
 *
 * Solution: ship a tiny in-container LLM that returns one deterministic
 * extracted fact echoing the request's conversation text, then point
 * core at it via `LLM_PROVIDER=openai-compatible` +
 * `LLM_API_URL=http://mock-openai-extraction:8080/v1`. Core's full
 * ingest path persists one memory per extracted fact, so this keeps
 * text-mode CLI add/import searchable without external credentials.
 */

import { createServer } from 'node:http';

const CONVERSATION_MARKER = 'Conversation to extract from:';
const MAX_FACT_TEXT_CHARS = 1500;
const MOCK_CREATED_AT = 1_700_000_000;
const PORT = Number(process.env.PORT ?? '8080');

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || !req.url) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: req.url }));
    return;
  }
  // Drain the request body before responding so the SDK doesn't see
  // a half-read socket. We also feed the body into `respondChat` so
  // the synthetic extracted fact can echo the operator's text and
  // downstream search/get assertions can find their marker substring.
  const chunks = [];
  req.on('data', (chunk) => { chunks.push(chunk); });
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    if (req.url.startsWith('/v1/chat/completions')) {
      respondChat(res, bodyText);
      return;
    }
    if (req.url.startsWith('/v1/embeddings')) {
      respondEmbeddings(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: req.url, bytesRead: bodyText.length }));
  });
});

function respondChat(res, requestBodyText) {
  // Echo the conversation back as a single extracted fact. Text-mode
  // ingest in core (`/v1/memories/ingest`) persists ONE memory per
  // extracted fact — returning `{memories: []}` would be valid but
  // would leave `stored_memory_ids: []`, which makes the CLI's
  // `add` adapter report `created: []` and breaks every downstream
  // get/search/delete assertion in the suite. Returning a single
  // fact whose `fact` field carries the original conversation text
  // means core stores one memory whose `content` includes the
  // operator's marker substring, so search/get assertions resolve
  // deterministically.
  const factText = extractConversationText(requestBodyText);
  const content = JSON.stringify({
    memories: [
      {
        fact: factText,
        statement: factText,
        headline: factText.slice(0, 80),
        importance: 0.9,
        type: 'knowledge',
        keywords: [],
        entities: [],
        relations: [],
      },
    ],
  });
  const body = {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: MOCK_CREATED_AT,
    model: 'mock-extractor',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function extractConversationText(requestBodyText) {
  // The OpenAI chat.completions request body is JSON with
  // `messages: [...]`. Take the LAST user message's content (or any
  // plausible substantive text) — that's where core's
  // `extractFacts` puts the conversation it wants summarized.
  // Fall back to a fixed sentinel if parsing fails so the response
  // is always valid JSON.
  try {
    const parsed = JSON.parse(requestBodyText);
    if (parsed && Array.isArray(parsed.messages)) {
      for (let i = parsed.messages.length - 1; i >= 0; i--) {
        const m = parsed.messages[i];
        if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
          return cleanConversationText(m.content);
        }
      }
    }
  } catch {
    // ignore — fall through
  }
  return 'Mock-extracted fact (no conversation found in request).';
}

function cleanConversationText(content) {
  const markerIndex = content.lastIndexOf(CONVERSATION_MARKER);
  const source = markerIndex >= 0
    ? content.slice(markerIndex + CONVERSATION_MARKER.length)
    : content;
  return source.trim().slice(0, MAX_FACT_TEXT_CHARS);
}

function respondEmbeddings(res) {
  // Embedding requests should never reach this mock — the smoke
  // overlay pins EMBEDDING_PROVIDER=transformers (local). Respond
  // with a deterministic 384-dim zero vector if anyone ever does
  // call us so the failure surface is "wrong embeddings" not
  // "connection refused".
  const body = {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: new Array(384).fill(0) }],
    model: 'mock-embedder',
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-openai-extraction] listening on :${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
