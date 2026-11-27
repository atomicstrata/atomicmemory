/** Workspace-linked memory tools exercised through real SDK HTTP and AI SDK generation. */
import type { IngestResult } from '@atomicmemory/sdk';
import { createMemory, type MemoryTools, type ReadOnlyMemoryTools, type MemorySearchOutput } from '@atomicmemory/vercel-ai/tools';
import { generateText, stepCountIs } from 'ai';
import { startLocalFixture } from './fixture-http.js';
import { scriptedModel, type ScriptedTurn } from './scripted-model.js';

type TurnResult<T extends ReadOnlyMemoryTools> = Awaited<ReturnType<typeof generateText<T>>>;

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
    const memory = await createMemory({ backend: 'local', url: fixture.apiUrl, apiKey: 'local-demo-key' });
    const writable = memory.toolsForUser('fixture-user-alice', { allowWrites: true });
    const readOnly = memory.toolsForUser('fixture-user-alice');
    const saved = await runTurn(writable, { tool: 'memory_ingest', content: 'I prefer tea.' });
    const recalled = await runTurn(readOnly, { tool: 'memory_search', query: 'preferred drink' });
    const changed = await runTurn(writable, { tool: 'memory_ingest', content: 'I now prefer coffee.' });
    const later = await runTurn(readOnly, { tool: 'memory_search', query: 'preferred drink' });
    const other = await runTurn(memory.toolsForUser('fixture-user-bob'),
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

async function runTurn<T extends ReadOnlyMemoryTools>(tools: T, turn: ScriptedTurn): Promise<TurnResult<T>> {
  const result = await generateText({
    model: scriptedModel(turn), tools, prompt: 'Execute the scripted memory operation.',
    stopWhen: stepCountIs(3),
  });
  if (result.steps.some(step => step.content.some(part => part.type === 'tool-error'))) {
    throw new Error('Offline memory operation failed.');
  }
  return result;
}

function ingestResult(result: TurnResult<MemoryTools>): IngestResult {
  for (const step of result.steps) for (const part of step.content) {
    if (part.type === 'tool-result' && !part.dynamic && part.toolName === 'memory_ingest') return part.output;
  }
  throw new Error('Offline ingest result missing.');
}

function searchResult(result: TurnResult<ReadOnlyMemoryTools>): MemorySearchOutput {
  for (const step of result.steps) for (const part of step.content) {
    if (part.type === 'tool-result' && !part.dynamic && part.toolName === 'memory_search') return part.output;
  }
  throw new Error('Offline search result missing.');
}
