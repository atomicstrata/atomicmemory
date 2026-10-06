/** Deterministic AI SDK model that answers from actual tool output in offline checks. */
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

type ModelResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;
type ModelRequest = Parameters<MockLanguageModelV3['doGenerate']>[0];
const searchOutput = z.object({ results: z.array(z.object({ content: z.string() })) });
const ingestOutput = z.object({
  created: z.array(z.string()), updated: z.array(z.string()), unchanged: z.array(z.string()),
});

/** A synthetic model instruction, with no autonomous inference. */
export type ScriptedTurn =
  | { tool: 'memory_search'; query: string }
  | { tool: 'memory_ingest'; content: string };

/** Request one tool, then derive the next answer from the resulting model prompt. */
export function scriptedModel(turn: ScriptedTurn): MockLanguageModelV3 {
  let firstStep = true;
  return new MockLanguageModelV3({
    doGenerate: async request => {
      if (firstStep) {
        firstStep = false;
        const input = turn.tool === 'memory_search' ? { query: turn.query } : { content: turn.content };
        return modelResult([{ type: 'tool-call', toolCallId: 'fixture-call',
          toolName: turn.tool, input: JSON.stringify(input) }], 'tool-calls');
      }
      const output = readToolOutput(request);
      const answer = turn.tool === 'memory_search'
        ? searchOutput.parse(output).results.map(hit => hit.content).join('\n') || 'No memories found.'
        : JSON.stringify(ingestOutput.parse(output));
      return modelResult([{ type: 'text', text: answer }], 'stop');
    },
  });
}

function readToolOutput(request: ModelRequest): unknown {
  for (const message of request.prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.output.type === 'json') return part.output.value;
    }
  }
  throw new Error('Offline model did not receive a successful JSON tool result.');
}

function modelResult(
  content: ModelResult['content'], reason: 'tool-calls' | 'stop',
): ModelResult {
  return {
    content,
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}
