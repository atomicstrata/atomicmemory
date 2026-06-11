# llmwiki Bridge Cookbook

Four-step workflow for taking raw sources → compiled wiki → AtomicMemory
runtime memory → injection-ready context.

## 0. Prerequisites

- `llmwiki` CLI available (see the [llmwiki repository](https://github.com/atomicstrata/llmwiki))
- An AtomicMemory provider that supports `verbatim` ingest. The
  `AtomicMemoryProvider` shipped in `@atomicmemory/sdk` qualifies.
- An AtomicMemory CLI profile already initialized (`atomicmemory init …`).

## 1. Compile the wiki

Inside an llmwiki project, drop your raw sources into `sources/` and
run the compiler:

```bash
llmwiki compile
```

This produces an interlinked markdown wiki under `wiki/`. The wiki is
useful on its own — readable, greppable, browsable. Stop here if you
don't need runtime recall.

## 2. Export to the bridge JSON envelope

```bash
llmwiki export --target json --project-id my-kb
```

The export lands at `dist/exports/wiki.json`. `--project-id` is a
**security boundary**: two projects supplying the same id collide in
AtomicMemory because the bridge derives external IDs from it. Pick
something stable and namespace it; treat it like a tenant key.

The envelope schema is documented at
[`packages/llmwiki/src/schema.ts`](../src/schema.ts); the regex pinning
the on-wire `projectId` is
`/^[a-z0-9][a-z0-9-]{0,62}$/`.

## 3. Import into AtomicMemory

```bash
atomicmemory import --type llmwiki dist/exports/wiki.json \
  --user "$USER" \
  --namespace knowledge
```

What happens:

- The CLI loads, validates, and size-checks the JSON file. Caps:
  100,000 pages, 1 MB per page body, 64 KB per other field, 256 MB
  total file size.
- The active provider is checked for `verbatim` capability; the bridge
  refuses to operate against text-only providers.
- Each page becomes one verbatim memory record with `metadata.llmwiki.*`
  carrying every advisory field from the export.
- Re-running this command on the same project will **refuse** until you
  pass `--allow-append-only --accept-duplicates`. AtomicMemory's
  verbatim ingest is not idempotent by external ID; without the opt-in
  flags, re-imports would silently double every page.

### Dry run

```bash
atomicmemory import --type llmwiki dist/exports/wiki.json --user "$USER" --dry-run
```

Prints the page paths that would be imported. No memory writes occur.

## 4. Query the runtime memory

Once imported, the wiki content is queryable like any other AtomicMemory
data:

```bash
atomicmemory search "chunking strategies" --user "$USER" --namespace knowledge
atomicmemory package "what is retrieval" --user "$USER" --namespace knowledge
```

`atomicmemory package` returns an injection-ready `ContextPackage` you
can hand directly to an LLM prompt.

## Querying the export without import

If you want to query the wiki directly through the SDK without ever
ingesting into AtomicMemory, use the read-only `SnapshotLLMWikiProvider`:

```ts
import { loadLLMWikiExport, SnapshotLLMWikiProvider } from "@atomicmemory/llmwiki";

const exportData = await loadLLMWikiExport("./wiki.json");
const provider = new SnapshotLLMWikiProvider({
  exportData,
  scope: { user: "alice", namespace: "knowledge" },
});

const hits = await provider.search({ query: "chunking", scope: provider["scope"] });
const pack = await provider.package({ query: "chunking", scope: provider["scope"] });
```

The provider is read-only by design; `ingest()` and `delete()` throw
`E_LLMWIKI_PROVIDER_READONLY`. Use the import path above when you want a
writable store.

## When to use which path

- **Compile + read the wiki**: lowest-overhead path; pure markdown.
- **Compile + read + `SnapshotLLMWikiProvider`**: queryable knowledge without
  a runtime store. Good for batch tasks, agents that consult one
  project at a time, CI checks.
- **Compile + import + AtomicMemory**: queryable runtime memory that
  can also accept new memories from other sources. Good when the wiki
  is a starting point and the agent learns more over time.
