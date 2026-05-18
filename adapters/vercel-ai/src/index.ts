/**
 * @file Public entry — four composable primitives for wiring
 *       AtomicMemory into Vercel AI SDK applications (or any
 *       message-driven model call), plus a helper that bridges
 *       AI SDK v5 `ModelMessage` content parts into the SDK's
 *       text-only `Message` shape.
 *
 *       Choose by flow shape:
 *       - `withMemory()` — text-only flows; one-call convenience.
 *       - `augmentWithMemory()` + `ingestTurn()` — text-only flows; split.
 *       - `retrieve()` + `ingestTurn()` — tool-call or multimodal flows;
 *         you keep your original ModelMessage array and just inject
 *         the returned system message into it.
 */

export { retrieve, defaultFormatter } from './retrieve.js';
export type { RetrieveOptions, RetrieveResult } from './retrieve.js';

export { augmentWithMemory } from './augment.js';
export type { AugmentOptions, AugmentResult } from './augment.js';

export { ingestTurn } from './ingest.js';
export type { IngestTurnOptions } from './ingest.js';

export { withMemory } from './with-memory.js';
export type { WithMemoryOptions, WithMemoryResult } from './with-memory.js';

export { fromModelMessage, fromModelMessages } from './from-model-message.js';
export type {
  ModelMessageLike,
  ModelMessagePartLike,
} from './from-model-message.js';
