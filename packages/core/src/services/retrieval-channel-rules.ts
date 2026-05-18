/**
 * Channel emission rules for retrieval-format injection.
 *
 * Each helper encodes which prompt channels are appropriate for a given
 * question type. The principle: emit only the channels that aid that
 * specific question type; suppress everything else so the answer LLM
 * isn't distracted by paraphrased content competing with raw facts.
 *
 * Smoke v1/v2 evidence: emitting all channels for every query (the "OTHER
 * keeps everything" rule) regressed IF/KU/IE by 0.25–0.75 because Haiku
 * fixated on paraphrased TIMELINE/EVENT_CHAIN content above the raw fact
 * block and produced "context does not contain information" even when
 * the literal fact was present. Conservative default: OTHER gets NO
 * auxiliary channels — let the LLM work with raw retrieved facts unless
 * the question type explicitly benefits from a channel.
 */

import { QuestionType } from './answer-format.js';

/**
 * Whether to emit the ## EVENT_CHAIN channel.
 * Only ORDERED_LIST queries need chronological per-entity event chains.
 * OTHER suppresses it — chains paraphrase content and compete with raw facts.
 */
export function shouldEmitEventChain(qt: QuestionType): boolean {
  return qt === QuestionType.ORDERED_LIST;
}

/**
 * Whether to emit the ## OBSERVATIONS channel (Reflect-synthesized).
 * Only CONTRADICTION and SUMMARY queries benefit; other types use raw facts.
 */
export function shouldEmitObservations(qt: QuestionType): boolean {
  return qt === QuestionType.CONTRADICTION
    || qt === QuestionType.SUMMARY;
}

/**
 * Whether to apply the Layer 1 per-type format hint.
 * Skipped for PREFERENCE (no hint exists) and OTHER (no classification
 * matched, no rationale to constrain the answer format).
 */
export function shouldApplyFormatHint(qt: QuestionType): boolean {
  return qt !== QuestionType.PREFERENCE && qt !== QuestionType.OTHER;
}
