/**
 * @file OpenAI Chat Completions token-limit and reasoning_effort selection.
 *
 * Kept separate from llm.ts so provider wiring stays under the 400-line limit
 * and model-capability rules can evolve without bloating the LLM facade.
 */

/** Chat Completions reasoning_effort values we intentionally set. */
export type ReasoningEffort = 'none' | 'minimal' | 'low';

/** Model name with any provider prefix (e.g. `openai/`) stripped, lowercased. */
function bareModelName(model: string): string {
  const normalized = model.toLowerCase();
  return normalized.includes('/') ? normalized.split('/').pop() ?? normalized : normalized;
}

/**
 * o-series reasoning SKUs (o1, o3, o4, and future o<digit> like o5/o6).
 * Single definition shared by token-field selection and reasoning_effort
 * selection so the two guards cannot disagree on which models are
 * o-series — a mismatch would route a model to `max_completion_tokens`
 * while leaving reasoning steering (and the sampling/visible-output
 * guards) off, re-opening the 400/empty-output holes those guards close.
 */
function isOSeriesModel(model: string): boolean {
  return /^o\d(?:[-.]|$)/.test(bareModelName(model));
}

/**
 * Newer OpenAI / Azure chat models reject `max_tokens` in favor of
 * `max_completion_tokens`. The match is anchored so we do not
 * false-positive on `gpt-500` and handles prefixed routes like
 * `openai/o3-mini` or `azure/gpt-5.1`. Future o<digit> SKUs
 * (o5, o6, ...) are matched by {@link isOSeriesModel}.
 */
export function prefersMaxCompletionTokens(model: string): boolean {
  const bare = bareModelName(model);
  if (/^gpt-5(?:[-.]|$)/.test(bare)) return true;
  return isOSeriesModel(model);
}

/**
 * Duck-typed shape of the OpenAI SDK's `APIError` we key off of. Tests
 * do not need to construct an APIError instance and the classifier
 * still works against SDK versions that surface the fields at
 * different depths.
 */
interface StructuredOpenAIError {
  code?: string | null;
  param?: string | null;
  error?: { code?: string | null; param?: string | null };
}

function structuredOpenAIError(error: unknown): StructuredOpenAIError | null {
  if (!error || typeof error !== 'object') return null;
  return error as StructuredOpenAIError;
}

/**
 * True when the SDK error identifies `max_tokens` as unsupported.
 * Prefers OpenAI's structured `code` / `param` fields (populated on
 * `APIError`) and falls back to substring matching only when the
 * structured shape is unavailable (older SDKs, compatible backends).
 */
export function isMaxTokensUnsupportedError(error: unknown): boolean {
  const structured = structuredOpenAIError(error);
  if (structured) {
    const code = structured.code ?? structured.error?.code;
    const param = structured.param ?? structured.error?.param;
    if (code === 'unsupported_parameter' && param === 'max_tokens') return true;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('max_tokens') && message.includes('max_completion_tokens');
}

/**
 * True when the request body was rejected as malformed JSON — usually
 * caused by unescaped control characters in a user-supplied message.
 * Colocated with the OpenAI-specific classifiers so the retry helper
 * has a single place to source them from.
 */
export function isJsonBodyParseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('parse the JSON body of your request');
}

/**
 * Map provider-neutral `maxTokens` to the OpenAI chat completion field.
 *
 * For models that use `max_completion_tokens`, the API counts reasoning and
 * visible tokens together. We map 1:1 and set a capability-aware
 * {@link openAIReasoningParams} effort. A 50-token combined cap is still not
 * a visible-output guarantee when reasoning cannot be fully disabled.
 */
export function openAIChatTokenLimit(
  model: string,
  maxTokens: number | undefined,
  forceMaxCompletionTokens = false,
): Record<string, number> {
  if (maxTokens === undefined) return {};
  if (forceMaxCompletionTokens || prefersMaxCompletionTokens(model)) {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens };
}

/** Pro SKUs are Responses API only — not valid Chat Completions models. */
function isResponsesOnlyOpenAIProSku(model: string): boolean {
  // Strip the provider prefix first: without it, a route like
  // `pro-router/gpt-5` would false-positive on the leading `pro`.
  const bare = bareModelName(model);
  return /(^|[-_.])pro($|[-_.\d])/.test(bare) || bare.endsWith('pro');
}

/**
 * Older Codex SKUs (gpt-5 / gpt-5.1) are Responses-only; gpt-5.2-codex+ support Chat.
 */
function isResponsesOnlyOpenAICodexSku(model: string): boolean {
  // Strip the provider prefix first: the anchored `^gpt-5` below would
  // otherwise miss `openai/gpt-5-codex` and route a Responses-only SKU to
  // Chat Completions.
  const bare = bareModelName(model);
  if (!isGpt5CodexSku(bare)) return false;
  const minor = gpt5MinorVersion(bare);
  if (minor === undefined) {
    return /^gpt-5(?:[-_.]|$)/.test(bare);
  }
  return minor <= 1;
}

function isResponsesOnlyOpenAISku(model: string): boolean {
  return isResponsesOnlyOpenAIProSku(model) || isResponsesOnlyOpenAICodexSku(model);
}

/** Codex-tuned GPT-5 SKUs document low/medium/high/xhigh — not none/minimal. */
function isGpt5CodexSku(model: string): boolean {
  return model.includes('codex');
}

/**
 * ChatGPT-tuned `*-chat-latest` SKUs expose Chat Completions but do not
 * document reasoning_effort — omit the optional param rather than inferring
 * from the numeric GPT-5 version.
 */
function isGpt5ChatLatestSku(model: string): boolean {
  return model.includes('chat-latest');
}

/** Minor version from `gpt-5.<n>`; undefined when the model has no dotted minor. */
function gpt5MinorVersion(model: string): number | undefined {
  const match = model.match(/gpt-5\.(\d+)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Fail closed when the configured model cannot be used with Chat Completions.
 */
export function assertOpenAIChatCompletionsModel(model: string): void {
  if (!isResponsesOnlyOpenAISku(model)) return;
  throw new Error(
    `OpenAI model "${model}" is Responses API only and is not supported by the Chat Completions provider — pick a Chat Completions model (e.g. gpt-5.4-mini) or a Responses-capable integration`,
  );
}

/**
 * Pick a Chat Completions `reasoning_effort` for short structured calls.
 * Returns `undefined` when the parameter must be omitted (unsupported SKU).
 *
 * Capabilities are separate from `max_completion_tokens` support and from
 * numeric GPT-5 minor versions alone:
 * - Responses-only Pro SKUs: omit (caller must not reach Chat Completions)
 * - ChatGPT-tuned `*-chat-latest`: omit (reasoning_effort undocumented)
 * - GPT-5 Codex SKUs: `low` (none/minimal unsupported)
 * - GPT-5.1+ base/mini chat: `none`
 * - Original GPT-5 family: `minimal`
 * - o-series (o1/o3/o4 and future o<digit> like o5): `low`
 */
export function reasoningEffortForModel(model: string): ReasoningEffort | undefined {
  const normalized = model.toLowerCase();
  if (!prefersMaxCompletionTokens(normalized)) return undefined;
  if (isResponsesOnlyOpenAISku(normalized)) return undefined;
  // Before GPT-5.1+ none — chat-latest pages do not document reasoning_effort.
  if (isGpt5ChatLatestSku(normalized)) return undefined;
  // Before GPT-5.1+ none — e.g. gpt-5.3-codex has minor 3 but rejects none.
  if (isGpt5CodexSku(normalized)) return 'low';

  const minor = gpt5MinorVersion(normalized);
  if (minor !== undefined) {
    return minor >= 1 ? 'none' : 'minimal';
  }
  if (normalized.includes('gpt-5') || /^gpt-5/.test(normalized)) {
    return 'minimal';
  }
  if (isOSeriesModel(normalized)) {
    return 'low';
  }
  return undefined;
}

/** Reasoning controls for models that share the completion budget with CoT. */
export function openAIReasoningParams(
  model: string,
  _forceMaxCompletionTokens = false,
): Record<string, string> {
  // Only attach effort for models that use max_completion_tokens natively.
  // Forced retries on legacy names must not invent unsupported reasoning params.
  if (!prefersMaxCompletionTokens(model)) {
    return {};
  }
  const effort = reasoningEffortForModel(model);
  return effort === undefined ? {} : { reasoning_effort: effort };
}

/**
 * True when the model actually runs reasoning that competes with the
 * visible `max_completion_tokens` budget — effort is `minimal` or `low`.
 * `reasoning_effort: 'none'` disables reasoning (the model behaves as a
 * standard Chat Completions model), and `undefined` means we do not steer
 * reasoning at all (legacy / sampling models); neither counts as active.
 *
 * Both the sampling-param omission and the empty-output guard key off this
 * single definition, so `none` models keep caller sampling (temperature,
 * seed) and are not fail-closed on empty output — only genuinely-reasoning
 * models are.
 */
function isActiveReasoningModel(model: string): boolean {
  const effort = reasoningEffortForModel(model);
  return effort === 'minimal' || effort === 'low';
}

/**
 * Sampling controls (`temperature`, `seed`) for the OpenAI Chat
 * Completions provider. Models that are actively reasoning (GPT-5 family
 * and o-series at effort `minimal`/`low`) reject non-default sampling
 * controls — OpenAI's model pages document only `temperature: 1` and
 * ignore `seed` — so we omit both rather than pass `0` and take a 400.
 *
 * Models with `reasoning_effort: 'none'` (reasoning off) and legacy models
 * behave as standard Chat Completions models and KEEP the caller's
 * sampling controls; dropping them would silently discard the determinism
 * (`temperature: 0`, fixed `seed`) callers depend on. If a concrete backend
 * ever rejects these on a `none` model, surface that mismatch explicitly
 * rather than pre-emptively weakening determinism here.
 *
 * See https://developers.openai.com/api/docs/models/gpt-5 and the
 * o-series model pages for the documented parameter surface.
 */
export function openAISamplingParams(
  model: string,
  temperature: number | undefined,
  seed: number | undefined,
): Record<string, number> {
  if (isActiveReasoningModel(model)) return {};
  const params: Record<string, number> = { temperature: temperature ?? 0 };
  if (seed !== undefined) params.seed = seed;
  return params;
}

/** Choice shape we depend on for visible-output validation. */
export interface OpenAIChatChoice {
  message: { content: string | null };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
}

/**
 * Fail closed when a Chat Completions choice cannot be handed to a
 * downstream consumer. Two independent failure modes converge here so
 * the guard is a single chokepoint (cross-cutting rule):
 *
 * 1. `finish_reason === 'length'` — the model stopped at the cap
 *    before generation completed. A non-empty prefix is still
 *    incomplete (partial JSON / truncated namespace), and would be
 *    persisted silently by callers like `classifyNamespace(...)` in
 *    memory-storage.ts. Reject every truncated response regardless of
 *    whether the visible slot is empty or not.
 * 2. Empty visible content on an active reasoning model — reasoning
 *    consumed the shared `max_completion_tokens` budget before any
 *    visible output. Whitespace-only content is treated as empty here
 *    (`content.trim() === ''`); silently returning `'   '` would end
 *    up as a blank namespace/fact downstream.
 */
export function assertVisibleChatOutput(model: string, choice: OpenAIChatChoice): string {
  const content = choice.message.content;
  const finishReason = choice.finish_reason;
  const empty = content == null || content.trim() === '';
  if (finishReason === 'length') {
    throw new Error(
      `OpenAI model "${model}" returned truncated output `
      + `(finish_reason=length, ${empty ? 'empty' : 'non-empty but incomplete'} content). `
      + 'The max_completion_tokens budget was exhausted before generation completed — '
      + 'a partial response is not a valid downstream input. Increase maxTokens, or pick '
      + "a model that accepts reasoning_effort: 'none' so reasoning does not compete "
      + 'with the visible budget.',
    );
  }
  // Only genuinely-reasoning models (effort minimal/low) reach this guard;
  // `none` and legacy models fall through and return their (empty) content,
  // exactly like a standard Chat Completions model.
  if (empty && isActiveReasoningModel(model)) {
    throw new Error(
      `OpenAI model "${model}" returned empty content (finish_reason=${finishReason ?? 'null'}). `
      + 'The max_completion_tokens budget was consumed by reasoning tokens before any '
      + 'visible output was produced. Increase maxTokens, or pick a model that accepts '
      + "reasoning_effort: 'none' (e.g. gpt-5.1+ base/mini) so reasoning does not "
      + 'compete with the visible budget.',
    );
  }
  return content ?? '';
}

/**
 * Total attempts (initial + up to two bounded mitigations). Kept as a
 * named constant so both the caller and its tests share one budget
 * ceiling — this is what makes the retry demonstrably bounded.
 */
export const OPENAI_CHAT_MAX_ATTEMPTS = 3;

/**
 * Mutable per-request retry state for the OpenAI Chat Completions
 * provider. The two flags are independent: `aggressiveSanitize` fixes
 * malformed-JSON-body errors and `forceMaxCompletionTokens` fixes the
 * `max_tokens` → `max_completion_tokens` rename. Each transition is
 * allowed at most once (see {@link tryApplyOpenAIRetry}), so composing
 * both mitigations still terminates in at most three requests.
 */
export interface OpenAIRetryState {
  aggressiveSanitize: boolean;
  forceMaxCompletionTokens: boolean;
}

/**
 * Apply the next unused bounded mitigation for a failed chat request.
 *
 * Returns `true` when `state` was mutated and the caller should retry;
 * returns `false` when the error is not one we recognize *or* when the
 * matching mitigation has already been applied — in both cases the
 * caller must propagate the error. Modeling the two mitigations as
 * independent one-shot flags (rather than mutually exclusive catch
 * branches) is what lets a parse→token or token→parse sequence recover
 * on the third request without ever regressing into an unbounded loop.
 */
export function tryApplyOpenAIRetry(error: unknown, state: OpenAIRetryState): boolean {
  if (!state.aggressiveSanitize && isJsonBodyParseError(error)) {
    state.aggressiveSanitize = true;
    return true;
  }
  if (!state.forceMaxCompletionTokens && isMaxTokensUnsupportedError(error)) {
    state.forceMaxCompletionTokens = true;
    return true;
  }
  return false;
}
