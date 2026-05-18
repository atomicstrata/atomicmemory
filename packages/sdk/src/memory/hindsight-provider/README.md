# Hindsight provider

The Hindsight provider lets the SDK use Hindsight Cloud or a self-hosted
Hindsight API as a memory backend.

## Configuration

Cloud example:

```ts
const client = new MemoryClient({
  providers: {
    hindsight: {
      apiUrl: 'https://api.hindsight.vectorize.io',
      apiKey: process.env.HINDSIGHT_API_KEY,
      apiVersion: 'v1',
      projectId: 'default',
    },
  },
});
```

Self-hosted Docker example:

```ts
const client = new MemoryClient({
  providers: {
    hindsight: {
      apiUrl: 'http://localhost:8888',
      apiVersion: 'v1',
      projectId: 'default',
    },
  },
});
```

`defaultMaxTokens` controls the fallback Hindsight `max_tokens` value for
recall-backed search and packaging. `PackageRequest.tokenBudget` takes
precedence for `package()`.

`defaultBudget` controls the fallback Hindsight recall budget. Request-level
typed budget overrides are not part of the first-pass provider contract.

`SearchRequest.limit` is applied after Hindsight recall returns; it caps SDK
results and is not sent as Hindsight `max_tokens`.

## Scope mapping

The provider maps SDK scope to Hindsight banks and tags:

- `scope.user` routes to `bank_id` and is required.
- `scope.agent` maps to tag `agent:<value>`.
- `scope.namespace` maps to tag `namespace:<value>`.
- `scope.thread` maps to tag `thread:<value>`.

`ingest`, `search`, `package`, and `reflect` apply the derived tags.
Recall-backed operations use `tags_match: 'all_strict'` so scoped reads exclude
untagged memories and require all supplied scope tags.

`list`, `get`, and `delete` are bank-scoped by `user` and memory id because the
verified Hindsight list/get/delete contract does not expose the same tag filter
surface.

## Contract notes

Hindsight retain does not document stable created memory IDs. Successful
`ingest()` therefore returns:

```ts
{ created: [], updated: [], unchanged: [] }
```

Callers that need the raw retain response can use:

```ts
const retain = client.getExtension<HindsightRetainHandle>('hindsight.retain');
const retained = await retain?.retain({
  mode: 'text',
  content: 'Alice joined the platform team.',
  scope: { user: 'alice' },
});
```

Callers that need async operation status can use:

```ts
const operations = client.getExtension<HindsightOperationsHandle>(
  'hindsight.operations',
);
const operation = retained?.operation_id
  ? await operations?.get({ user: 'alice' }, retained.operation_id)
  : null;
```

Hindsight recall does not document a stable numeric score field, so search
results use `score: 0` as the provider-score sentinel. Hindsight reflect does
not expose per-answer confidence, so `Insight.confidence` is also `0`.

The provider throws when a returned memory lacks `id`, `text`, or a documented
timestamp field (`created_at`, `mentioned_at`, or `date`) instead of fabricating
SDK-visible memory data.

## Live Integration Test

After starting Hindsight locally, run the opt-in live test with:

```bash
HINDSIGHT_TEST_API_URL=http://localhost:8890 pnpm exec vitest run src/memory/hindsight-provider/__tests__/hindsight-provider.integration.test.ts --reporter verbose
```

The test is skipped by default when `HINDSIGHT_TEST_API_URL` is not set.
