/**
 * Typed Belief Calculus (TBC) — Phase 2 LLM resolver.
 *
 * The TBC is a strict superset of AUDN's `Add | Update | Delete | No-op`
 * decision space. It introduces eight typed operators that each carry
 * explicit storage semantics: Affirm, Update, Retract, Supersede, Promote,
 * Demote, EvidenceFor, Counter.
 *
 * Phase 2 (this revision) wires `decideBeliefOperator` to a real LLM call
 * and lets `memory-audn.ts` route through it when `RuntimeConfig.tbcEnabled`
 * is true. Schema is unchanged — TBC mutations write to existing JSONB
 * metadata only. See `tbc-execution.ts` for the executor.
 */

import type { ChatMessage, LLMProvider } from './llm.js';
import { llm as defaultLlm } from './llm.js';
import type { CandidateMemory } from './conflict-policy.js';
import type { MemoryMetadata } from '../db/repository-types.js';
import type { FactInput } from './memory-service-types.js';
import { extractFirstJsonObject } from './extraction.js';

const TBC_MAX_TOKENS = 4096;
const TBC_MAX_CANDIDATES = 3;

/**
 * The eight typed belief operators that extend AUDN.
 *
 * Each operator describes a distinct effect on the belief graph; they are
 * not mutually exclusive intents over the same evidence — `decideBeliefOperator`
 * always picks exactly one per ingest, mirroring how AUDN picks exactly one
 * AUDNAction today.
 */
export enum BeliefOperator {
  /** New evidence supports an existing claim — strengthen confidence, no new claim. */
  Affirm = 'AFFIRM',
  /** Same attribute, different value — versioned supersession with both states retained. */
  Update = 'UPDATE',
  /** Claim now believed false (no replacement) — mark RETRACTED, preserve as evidence. */
  Retract = 'RETRACT',
  /** Replaced by a more specific or general claim — link old to new; both queryable. */
  Supersede = 'SUPERSEDE',
  /** Strong, repeated belief becomes a directive (constraint tier) influencing answer prompt. */
  Promote = 'PROMOTE',
  /** Challenged but not retracted — lower confidence; flag for re-evaluation. */
  Demote = 'DEMOTE',
  /** Adds an evidence-for edge to a supported claim — does not introduce a new claim. */
  EvidenceFor = 'EVIDENCE_FOR',
  /** Adds a counter edge to a challenged claim — does not introduce a new claim. */
  Counter = 'COUNTER',
}

const VALID_OPERATORS = new Set<string>(Object.values(BeliefOperator));

/**
 * Decision produced by the TBC resolver for a single inbound claim.
 *
 * - `operator` is the chosen typed operator from the eight in `BeliefOperator`.
 * - `target_claim_id` identifies the existing belief targeted by the operator.
 *   Required for every operator except `Affirm` when no target was found.
 * - `confidence_delta` is the proposed change to the target claim's confidence
 *   in `[-1, 1]`. Operators that introduce a brand-new claim should report `0`.
 * - `rationale` is a free-form natural-language justification for the operator
 *   choice; surfaced in trace events and used by audit/debug consumers.
 */
export interface BeliefOperationDecision {
  operator: BeliefOperator;
  target_claim_id?: string;
  confidence_delta: number;
  rationale: string;
}

/**
 * A single prior belief state, captured when a TBC operator mutates a claim.
 *
 * Phase 2 stores these only in memory metadata (additive). Phase 3 will
 * normalize them into a `belief_revision_history` table.
 */
export interface BeliefRevisionEntry {
  /** Operator that produced this entry. */
  operator: BeliefOperator;
  /** Confidence at the time this entry was recorded, in `[0, 1]`. */
  confidence: number;
  /** Optional content snapshot — `null` for graph-only operators (EvidenceFor / Counter). */
  content: string | null;
  /** ISO-8601 timestamp of the revision. */
  recordedAt: string;
  /** Free-form rationale carried forward from the originating decision. */
  rationale: string;
  /**
   * Edge weight in `[-1, 1]` for graph-only operators. Positive for
   * EvidenceFor, negative for Counter, undefined for content mutations.
   */
  weight?: number;
}

/**
 * Belief-aware metadata extension to the existing `MemoryMetadata` shape.
 *
 * The keys are additive — Phase 2 does not move any AUDN-era fields. When
 * `TBC_ENABLED=false` (default), nothing in this interface is read or written
 * and the AUDN behavior is unchanged.
 */
export interface BeliefMetadata extends MemoryMetadata {
  /** Current confidence of the belief in `[0, 1]`. */
  confidence?: number;
  /** The TBC operator that most recently mutated this memory. */
  mutation_type?: BeliefOperator;
  /** True when this memory has been promoted to the directive tier. */
  directive?: boolean;
  /** Append-only list of prior states recorded by previous TBC mutations. */
  revision_history?: BeliefRevisionEntry[];
  /** Append-only edge log written by EvidenceFor/Counter operators. */
  belief_edges?: BeliefRevisionEntry[];
}

/** Raised when the LLM resolver cannot produce a usable TBC decision. */
export class BeliefResolverError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'BeliefResolverError';
  }
}

const TBC_SYSTEM_PROMPT = `You are a belief-state reconciliation system. Given a NEW atomic claim and up to ${TBC_MAX_CANDIDATES} CANDIDATE existing claims (each with current belief state), pick exactly ONE typed belief operator that best describes the relationship.

OPERATORS:
- AFFIRM: NEW supports an existing CANDIDATE; no new claim is created. Strengthens the target.
- UPDATE: NEW corrects a CANDIDATE about the same attribute (minor edit / typo / qualifier).
- RETRACT: NEW asserts an existing CANDIDATE is false, with no replacement.
- SUPERSEDE: NEW replaces a CANDIDATE with a more specific or more general claim. Both remain queryable.
- PROMOTE: NEW reinforces a repeatedly-affirmed CANDIDATE strongly enough that it should become a directive.
- DEMOTE: NEW challenges a CANDIDATE but is not strong enough to retract — lower its confidence.
- EVIDENCE_FOR: NEW is itself novel content but adds a supporting edge to a CANDIDATE.
- COUNTER: NEW is itself novel content but adds a contradicting edge to a CANDIDATE.

RULES:
- Pick AFFIRM when the candidate set is empty AND the new claim has no clear target.
- target_claim_id MUST match one of the CANDIDATE ids when the operator references a target.
- confidence_delta is in [-1, 1]: positive for AFFIRM/EVIDENCE_FOR/PROMOTE, negative for DEMOTE/COUNTER/RETRACT, 0 for UPDATE/SUPERSEDE.
- Prefer EVIDENCE_FOR over AFFIRM when the new claim contains genuinely novel surface content but semantically supports the target.

OUTPUT FORMAT (JSON):
{
  "operator": "AFFIRM" | "UPDATE" | "RETRACT" | "SUPERSEDE" | "PROMOTE" | "DEMOTE" | "EVIDENCE_FOR" | "COUNTER",
  "target_claim_id": null | "id of candidate",
  "confidence_delta": -1.0 to 1.0,
  "rationale": "one sentence justification"
}

Return only the JSON object. Do not wrap it in markdown fences. Do not explain your reasoning outside the JSON.`;

interface BeliefCandidateView {
  id: string;
  content: string;
  similarity: number;
  confidence: number;
  mutation_type: BeliefOperator | null;
  history_depth: number;
}

function viewCandidate(candidate: CandidateMemory): BeliefCandidateView {
  // Phase 2 does not yet hydrate confidence from storage; future phases pass
  // the loaded BeliefMetadata in. For now we report the AUDN-era defaults.
  return {
    id: candidate.id,
    content: candidate.content,
    similarity: candidate.similarity,
    confidence: 1.0,
    mutation_type: null,
    history_depth: 0,
  };
}

function buildTbcUserMessage(
  newClaim: FactInput,
  candidates: readonly CandidateMemory[],
): string {
  const trimmed = candidates.slice(0, TBC_MAX_CANDIDATES).map(viewCandidate);
  const candidatesBlock = trimmed.length === 0
    ? '(no candidates)'
    : trimmed.map((c) => (
      `[ID: ${c.id}] (similarity: ${c.similarity.toFixed(2)}, confidence: ${c.confidence.toFixed(2)}, mutation: ${c.mutation_type ?? 'NONE'}, history_depth: ${c.history_depth}) ${c.content}`
    )).join('\n');
  return `NEW CLAIM: ${newClaim.fact}\n\nCANDIDATE CLAIMS:\n${candidatesBlock}`;
}

interface RawTbcResponse {
  operator?: unknown;
  target_claim_id?: unknown;
  confidence_delta?: unknown;
  rationale?: unknown;
}

function parseTbcDecision(
  raw: string,
  candidateIds: ReadonlySet<string>,
): BeliefOperationDecision {
  const cleaned = extractFirstJsonObject(raw);
  let parsed: RawTbcResponse;
  try {
    parsed = JSON.parse(cleaned) as RawTbcResponse;
  } catch (err) {
    throw new BeliefResolverError(
      `TBC resolver returned non-JSON output: ${cleaned.slice(0, 400)}`,
      err,
    );
  }
  return validateTbcDecision(parsed, candidateIds);
}

/** Operators that require a target_claim_id from the candidate set. AFFIRM is the only exception. */
const TARGET_REQUIRED_OPERATORS = new Set<BeliefOperator>([
  BeliefOperator.Update,
  BeliefOperator.Retract,
  BeliefOperator.Supersede,
  BeliefOperator.Promote,
  BeliefOperator.Demote,
  BeliefOperator.EvidenceFor,
  BeliefOperator.Counter,
]);

// fallow-ignore-next-line complexity
function validateTbcDecision(
  parsed: RawTbcResponse,
  candidateIds: ReadonlySet<string>,
): BeliefOperationDecision {
  const operator = typeof parsed.operator === 'string' && VALID_OPERATORS.has(parsed.operator)
    ? parsed.operator as BeliefOperator
    : null;
  if (!operator) {
    throw new BeliefResolverError(`TBC resolver returned invalid operator: ${String(parsed.operator)}`);
  }
  const target = typeof parsed.target_claim_id === 'string' ? parsed.target_claim_id : null;
  if (target !== null && !candidateIds.has(target)) {
    throw new BeliefResolverError(
      `TBC resolver returned target_claim_id "${target}" not in candidate set [${[...candidateIds].join(', ')}]`,
    );
  }
  if (TARGET_REQUIRED_OPERATORS.has(operator) && target === null) {
    throw new BeliefResolverError(
      `TBC resolver picked ${operator} but provided no target_claim_id. ${operator} requires one of [${[...candidateIds].join(', ')}].`,
    );
  }
  const deltaRaw = typeof parsed.confidence_delta === 'number' ? parsed.confidence_delta : 0;
  const confidence_delta = Number.isFinite(deltaRaw) ? Math.max(-1, Math.min(1, deltaRaw)) : 0;
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
  return {
    operator,
    ...(target ? { target_claim_id: target } : {}),
    confidence_delta,
    rationale,
  };
}

/**
 * Resolve a typed belief operator for a candidate set via an LLM call.
 *
 * Fail-closed: any LLM transport failure or parser failure raises
 * `BeliefResolverError` rather than silently returning an `Affirm`/`ADD`
 * stub. AUDN's existing executor will surface the error to the caller.
 *
 * The signature mirrors `resolveAUDN(factText, candidates)` so the
 * `memory-audn.ts` call site can swap it in cleanly.
 *
 * @param newClaim - The inbound atomic claim about to be ingested.
 * @param candidates - Conflict candidates already discovered via the standard
 *   AUDN candidate search; same input AUDN sees today.
 * @param llmClient - Optional LLM provider override for tests; defaults to
 *   the shared singleton in `services/llm.ts`.
 * @returns A `BeliefOperationDecision` selecting one of the eight operators.
 */
export async function decideBeliefOperator(
  newClaim: FactInput,
  candidates: readonly CandidateMemory[],
  llmClient: LLMProvider = defaultLlm,
): Promise<BeliefOperationDecision> {
  const candidateIds = new Set(candidates.slice(0, TBC_MAX_CANDIDATES).map((c) => c.id));
  const messages: ChatMessage[] = [
    { role: 'system', content: TBC_SYSTEM_PROMPT },
    { role: 'user', content: buildTbcUserMessage(newClaim, candidates) },
  ];
  return runTbcLlmWithRetry(messages, candidateIds, llmClient);
}

/**
 * Issue the TBC LLM call and parse. On parser/validation failure, retry ONCE
 * with the validation error appended to the prompt as corrective context.
 * Fail-closed (re-throws) if the retry also fails — preserves AUDN semantics.
 */
async function runTbcLlmWithRetry(
  messages: ChatMessage[],
  candidateIds: ReadonlySet<string>,
  llmClient: LLMProvider,
): Promise<BeliefOperationDecision> {
  try {
    return await callAndParseTbc(messages, candidateIds, llmClient);
  } catch (firstErr) {
    if (!(firstErr instanceof BeliefResolverError)) throw firstErr;
    const correctiveTurn: ChatMessage = {
      role: 'user',
      content: `Your previous response was invalid: ${firstErr.message}\nReturn a valid JSON object that conforms to the schema. If you pick UPDATE, RETRACT, SUPERSEDE, PROMOTE, DEMOTE, EVIDENCE_FOR, or COUNTER, you MUST set target_claim_id to one of the candidate IDs above.`,
    };
    return callAndParseTbc([...messages, correctiveTurn], candidateIds, llmClient);
  }
}

async function callAndParseTbc(
  messages: ChatMessage[],
  candidateIds: ReadonlySet<string>,
  llmClient: LLMProvider,
): Promise<BeliefOperationDecision> {
  let raw: string;
  try {
    raw = await llmClient.chat(messages, { temperature: 0, jsonMode: true, maxTokens: TBC_MAX_TOKENS });
  } catch (err) {
    throw new BeliefResolverError(`TBC resolver LLM call failed: ${(err as Error).message}`, err);
  }
  if (!raw) {
    throw new BeliefResolverError('TBC resolver returned empty content');
  }
  return parseTbcDecision(raw, candidateIds);
}
