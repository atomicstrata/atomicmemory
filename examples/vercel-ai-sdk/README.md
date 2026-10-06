# Memory tools with Vercel AI SDK 6

This example imports `memoryTools` from `@atomicmemory/vercel-ai-sdk/tools` and
links both AtomicMemory packages through the repository's pnpm workspace settings.
Its registry-compatible version ranges resolve to the local packages during
`pnpm install`. It does not import source files or require publishing the renamed
package first.

The framework integration lives in `adapters/vercel-ai-sdk`. Contributors maintaining
that adapter also maintain this example. Its build, typecheck, lint, and test scripts
run in the repository's affected CI lane on Node 22 and 24.

## Run the offline example

From the repository root, run:

```bash
pnpm install
pnpm exec turbo run build --filter=@atomicmemory/example-vercel-ai-sdk...
pnpm --filter @atomicmemory/example-vercel-ai-sdk smoke
pnpm --filter @atomicmemory/example-vercel-ai-sdk test
```

The smoke command starts an authenticated loopback HTTP fixture and runs the real
SDK HTTP client and AI SDK `generateText` loop. A deterministic test model selects
the tools and answers from their actual outputs. No Cloud or model keys are needed.

It saves a synthetic tea preference, recalls it in a fresh conversation, changes
the fixture preference to coffee, and checks that another user sees no memories.
The expected report includes:

```json
{
  "createdIds": ["fixture-fact-1"],
  "updatedIds": ["fixture-fact-1"],
  "firstRecall": "I prefer tea.",
  "laterRecall": "I now prefer coffee.",
  "otherUserRecall": "No memories found.",
  "hostedCloudVerified": false,
  "engineCorrectionVerified": false
}
```

The fixture is not the AtomicMemory engine. Its synthetic overwrite behavior does
not prove extraction, real correction resolution, terminal mutation receipts, or
deployed Cloud isolation. Its receipt uses synthetic model and trace identifiers.

## Run against a real service and model

Live mode is separate and fails if its configuration is missing. It never switches
to the offline fixture. Set these server-side environment variables:

```bash
export ATOMICMEMORY_API_URL=https://api.atomicstrata.ai
export ATOMICMEMORY_API_KEY=your-project-api-key
export ATOMICMEMORY_USER_ID=your-throwaway-demo-user
export OPENAI_API_KEY=your-model-api-key
export OPENAI_MODEL=your-supported-model-id
```

For local Core, use its API URL and key. Set
`ATOMICMEMORY_ALLOW_PRIVATE_NETWORKS=true` only for that explicitly trusted local
endpoint. Keep this permission disabled for hosted Cloud.

Run each prompt as a separate conversation:

```bash
pnpm --filter @atomicmemory/example-vercel-ai-sdk start "Remember that I prefer tea."
pnpm --filter @atomicmemory/example-vercel-ai-sdk start "What drink do I prefer? Search my memory first."
pnpm --filter @atomicmemory/example-vercel-ai-sdk start "Remember this correction: I now prefer coffee."
pnpm --filter @atomicmemory/example-vercel-ai-sdk start "What drink do I prefer now? Search my memory first."
```

The model chooses whether to call a tool. Inspect actual tool outcomes and retrieval
results before claiming an update. A successful v1 ingest reports ID arrays, not an
authoritative terminal correction receipt. Aborting a write does not roll it back.
Do not automatically retry a write after an uncertain network outcome.

Use synthetic data and a throwaway user for live experiments. In an application,
derive the scope from the authenticated server session, never from model arguments
or an untrusted chat body. The initial tools accept only `scope.user` because Cloud
v1 does not give the generic thread, namespace, and agent fields equivalent tenant
isolation semantics.

## Check documentation examples

Compile a guide's TypeScript fences against these same workspace packages:

```bash
pnpm --filter @atomicmemory/example-vercel-ai-sdk check:docs /path/to/guide.md
```

For a page containing alternative imports or incomplete reference snippets, select
the blocks that form one complete example with `--blocks 0,1,2`. Block indexes start
at zero. The checker concatenates the selected blocks and runs TypeScript without
executing the example or reading its environment variables. Its positive and
negative tests run in the same CI lane as the offline example.

## Compatibility

The example pins AI SDK `6.0.300` and its OpenAI provider `3.0.124`. It uses Zod
3.25.76 to match the adapter's development peers and keep ordinary workspace links.
Packed consumers also support Zod 4.1.8 and later.

The AtomicMemory packages require Node 22 or later. The offline tests pass on Node 22.23.3 and
24.21.0. This is separate from live-service verification. Do not infer Edge support
from this Node example.
