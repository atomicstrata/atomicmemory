/**
 * Verifier pass (Sprint 3 v1.7 — H5 from haiku-080).
 *
 * Second LLM call that re-grounds a candidate answer against retrieved
 * context. Fixes uncalibrated commitments where the answer LLM stated
 * specifics not supported by the context.
 *
 * Returns either the original answer (if grounded) or a rewritten
 * answer (if specifics in the candidate aren't supported). Fail-closed
 * on empty input, non-JSON response, or empty verified_answer — caller
 * (the AMB adapter or /v1/memories/verify route) is responsible for
 * the fail-soft behavior on the request boundary so non-AtomicMemory
 * runs are unaffected.
 */
import type { ChatMessage, LLMProvider } from './llm.js';
import { llm as defaultLlm } from './llm.js';
import { extractFirstJsonObject } from './extraction.js';

const VERIFIER_MAX_TOKENS = 768;

const VERIFIER_SYSTEM_PROMPT = [
  'You verify a candidate answer against retrieved context.',
  '',
  'Rules:',
  '- Read the question, the retrieved context, and the candidate answer.',
  '- If every specific fact, number, name, date, and quoted claim in the candidate answer is grounded in the retrieved context, return the candidate answer unchanged.',
  '- If any specific is not grounded, rewrite the answer to (a) drop the unsupported specifics, and (b) state grounded specifics from the context.',
  '- Do not invent new facts. If the context does not answer the question, return: "Based on the provided chat, there is no information related to this question."',
  '- Output JSON: {"verified_answer": "<string>", "changed": <boolean>}.',
  '- No markdown fences. No prose around the JSON.',
].join('\n');

export interface VerifierResult {
  verified_answer: string;
  changed: boolean;
}

export class AnswerVerifierError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AnswerVerifierError';
  }
}

function buildVerifierMessages(
  question: string,
  context: string,
  candidateAnswer: string,
): ChatMessage[] {
  return [
    { role: 'system', content: VERIFIER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `QUESTION:\n${question}`,
        '',
        `CONTEXT:\n${context}`,
        '',
        `CANDIDATE ANSWER:\n${candidateAnswer}`,
        '',
        'Return JSON: {"verified_answer": "...", "changed": true|false}.',
      ].join('\n'),
    },
  ];
}

function parseVerifierResponse(raw: string): VerifierResult {
  const cleaned = extractFirstJsonObject(raw);
  let parsed: { verified_answer?: unknown; changed?: unknown };
  try {
    parsed = JSON.parse(cleaned) as { verified_answer?: unknown; changed?: unknown };
  } catch (err) {
    throw new AnswerVerifierError(`verifier non-JSON: ${cleaned.slice(0, 200)}`, err);
  }
  const answer = typeof parsed.verified_answer === 'string' ? parsed.verified_answer : '';
  const changed = parsed.changed === true;
  if (!answer.trim()) {
    throw new AnswerVerifierError('verifier returned empty answer');
  }
  return { verified_answer: answer, changed };
}

export async function verifyAnswer(
  question: string,
  context: string,
  candidateAnswer: string,
  llmClient: LLMProvider = defaultLlm,
): Promise<VerifierResult> {
  if (!candidateAnswer.trim()) {
    throw new AnswerVerifierError('candidateAnswer is empty');
  }
  const messages = buildVerifierMessages(question, context, candidateAnswer);
  let raw: string;
  try {
    raw = await llmClient.chat(messages, {
      temperature: 0,
      jsonMode: true,
      maxTokens: VERIFIER_MAX_TOKENS,
    });
  } catch (err) {
    throw new AnswerVerifierError(`verifier LLM call failed: ${(err as Error).message}`, err);
  }
  return parseVerifierResponse(raw);
}
