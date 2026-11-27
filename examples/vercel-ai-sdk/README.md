# Memory tools with Vercel AI SDK 7

This example imports `createMemory` from `@atomicmemory/vercel-ai/tools`.
Its dependencies resolve to the local packages during
`pnpm install`. It does not import adapter source files or require publishing
version `0.2.0` first.

The framework integration lives in `adapters/vercel-ai`. Contributors maintaining
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

## Run against local Core and a real model

Set these server-side environment variables. This script uses local Core.
For Hosted Cloud setup, see the [Cloud quickstart](../../adapters/vercel-ai/README.md#cloud-quickstart).
Live mode never falls back to another backend or the offline fixture.

```bash
export ATOMICMEMORY_BACKEND=local
export CORE_API_URL=http://127.0.0.1:17350
export CORE_API_KEY=your-core-token
export ATOMICMEMORY_USER_ID=your-throwaway-demo-user
export OPENAI_API_KEY=your-model-api-key
export OPENAI_MODEL=your-supported-model-id
```

If you used the old workspace example, move your local token from
`ATOMICMEMORY_API_KEY` to `CORE_API_KEY`.

Run each command in a fresh process with the same user and backend:

```bash
pnpm --filter @atomicmemory/example-vercel-ai-sdk start save
pnpm --filter @atomicmemory/example-vercel-ai-sdk start recall
```

The script allows one save attempt and fails if the expected tool did not
complete or save did not return a created or updated ID. Check the saved ID
and the recalled tea preference; model text alone is not evidence.
A successful v1 ingest reports ID arrays, not an
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

The example pins AI SDK `7.0.181` and its OpenAI provider `4.0.123`. It uses Zod
3.25.76 to match the adapter's development peers and keep ordinary workspace links.
The adapter also supports AI SDK 5 and 6 and Zod `^4.1.8`.

The AtomicMemory packages require Node 22 or later. The offline tests pass on Node 22.23.3 and
24.21.0. This is separate from live-service verification. Do not infer Edge support
from this Node example.
