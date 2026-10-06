/** Workspace-linked memory tools exercised through real SDK HTTP and AI SDK generation. */
import { MemoryClient, type IngestResult } from '@atomicmemory/sdk';
import { memoryTools, type MemorySearchOutput } from '@atomicmemory/vercel-ai-sdk/tools';
import { generateText, stepCountIs } from 'ai';
import { startLocalFixture } from './fixture-http.js';
import { scriptedModel, type ScriptedTurn } from './scripted-model.js';

type Tools = ReturnType<typeof memoryTools>;
type TurnResult = Awaited<ReturnType<typeof generateText<Tools>>>;

/** Observable offline results, explicitly separate from hosted or real-engine verification. */
export interface DemoReport {
  backend: 'local-contract-fixture';
  model: 'deterministic-ai-sdk-test-model';
  createdIds: string[];
  updatedIds: string[];
  firstRecall: string;
  laterRecall: string;
  otherUserRecall: string;
  retrievalTraceId: string | undefined;
  hostedCloudVerified: false;
  engineCorrectionVerified: false;
}

/** Run fresh conversations against the same fixture, then verify another user's empty recall. */
export async function runOfflineDemo(): Promise<DemoReport> {
  const fixture = await startLocalFixture();
  try {
    const client = new MemoryClient({ providers: { atomicmemory: {
      apiUrl: fixture.apiUrl, apiKey: 'local-demo-key', allowPrivateNetworks: true,
    } } });
    await client.initialize();
    const tools = memoryTools({ client, scope: { user: 'fixture-user-alice' } });
    const saved = await runTurn(tools, { tool: 'memory_ingest', content: 'I prefer tea.' });
    const recalled = await runTurn(tools, { tool: 'memory_search', query: 'preferred drink' });
    const changed = await runTurn(tools, { tool: 'memory_ingest', content: 'I now prefer coffee.' });
    const later = await runTurn(tools, { tool: 'memory_search', query: 'preferred drink' });
    const other = await runTurn(memoryTools({ client, scope: { user: 'fixture-user-bob' } }),
      { tool: 'memory_search', query: 'preferred drink' });
    return {
      backend: 'local-contract-fixture', model: 'deterministic-ai-sdk-test-model',
      createdIds: ingestResult(saved).created, updatedIds: ingestResult(changed).updated,
      firstRecall: recalled.text, laterRecall: later.text, otherUserRecall: other.text,
      retrievalTraceId: searchResult(later).retrieval?.traceId,
      hostedCloudVerified: false, engineCorrectionVerified: false,
    };
  } finally {
    await fixture.close();
  }
}

async function runTurn(tools: Tools, turn: ScriptedTurn): Promise<TurnResult> {
  const result = await generateText({
    model: scriptedModel(turn), tools, prompt: 'Execute the scripted memory operation.',
    stopWhen: stepCountIs(3),
  });
  if (result.steps.some(step => step.content.some(part => part.type === 'tool-error'))) {
    throw new Error('Offline memory operation failed.');
  }
  return result;
}

function ingestResult(result: TurnResult): IngestResult {
  for (const step of result.steps) for (const part of step.content) {
    if (part.type === 'tool-result' && !part.dynamic && part.toolName === 'memory_ingest') return part.output;
  }
  throw new Error('Offline ingest result missing.');
}

function searchResult(result: TurnResult): MemorySearchOutput {
  for (const step of result.steps) for (const part of step.content) {
    if (part.type === 'tool-result' && !part.dynamic && part.toolName === 'memory_search') return part.output;
  }
  throw new Error('Offline search result missing.');
}
