/**
 * @file Deterministic input payloads for the fixture-capture script.
 *
 * Single source of truth so the capture script and any harness that
 * needs to know "what did we ingest?" agree. Changing a value here
 * will produce a fixture diff on next refresh — a deliberate change
 * to the captured contract, not drift.
 *
 * Each payload is deliberately ordinary text — no edge cases, no
 * Unicode tricks. The capture inputs exist to drive the mappers
 * across the wire shape; the mapper's correctness on edge cases is
 * covered by the hand-written unit test next to the fixture-driven
 * tests, not by the captured fixtures.
 *
 * `sourceUrl` values are populated on every ingest so the
 * `provenance.sourceUrl` semantic-contract assertion in
 * `to-memory.fixtures.test.ts` is load-bearing rather than vacuous.
 */

interface IngestPayload {
  conversation: string;
  source_site: string;
  source_url: string;
}

interface SearchPayload {
  query: string;
  limit: number;
}

/**
 * Body for `POST /v1/memories/ingest` — full extraction path.
 * The conversation contains a small, factual user statement so
 * core's extractor produces deterministic-shape (not necessarily
 * deterministic-content) memories.
 */
export const FULL_INGEST_PAYLOAD: IngestPayload = {
  conversation:
    "user: I prefer aisle seats on flights longer than four hours.\n" +
    "assistant: Noted — I will remember your seat preference for long flights.",
  source_site: "fixture-full-ingest",
  source_url: "https://example.com/fixtures/full-ingest-doc",
};

/**
 * Body for `POST /v1/memories/ingest/quick` — embedding-dedup-only
 * path. Different conversation text + source_site so episode_ids
 * don't collide with the full-ingest fixture.
 */
export const QUICK_INGEST_PAYLOAD: IngestPayload = {
  conversation:
    "user: Reminder: my library card expires in March 2027.",
  source_site: "fixture-quick-ingest",
  source_url: "https://example.com/fixtures/quick-ingest-doc",
};

/**
 * Body for `POST /v1/memories/search` and `/search/fast`. The query
 * touches content from both ingest payloads so the search response
 * consistently surfaces at least one memory across captures.
 */
export const SEARCH_PAYLOAD: SearchPayload = {
  query: "What does the user prefer about seat selection on flights?",
  limit: 5,
};
