/**
 * @file Pure-helper unit tests for OpenAI Chat Completions capability
 * selection and error classification. Request-path regressions live in
 * `openai-token-limit.test.ts`; splitting keeps each file under the
 * 400-line acceptance limit.
 */

import { describe, expect, it } from 'vitest';

import {
  assertOpenAIChatCompletionsModel,
  assertVisibleChatOutput,
  isJsonBodyParseError,
  isMaxTokensUnsupportedError,
  OPENAI_CHAT_MAX_ATTEMPTS,
  openAIChatTokenLimit,
  openAIReasoningParams,
  openAISamplingParams,
  prefersMaxCompletionTokens,
  reasoningEffortForModel,
  tryApplyOpenAIRetry,
  type OpenAIRetryState,
} from '../openai-chat-params.js';

describe('prefersMaxCompletionTokens', () => {
  it('matches gpt-5 family models', () => {
    expect(prefersMaxCompletionTokens('gpt-5.4-mini')).toBe(true);
    expect(prefersMaxCompletionTokens('gpt-5')).toBe(true);
  });

  it('matches reasoning-model prefixes', () => {
    expect(prefersMaxCompletionTokens('o1-preview')).toBe(true);
    expect(prefersMaxCompletionTokens('o3-mini')).toBe(true);
    expect(prefersMaxCompletionTokens('o4-mini')).toBe(true);
  });

  it('does not match legacy chat models', () => {
    expect(prefersMaxCompletionTokens('gpt-4o-mini')).toBe(false);
    expect(prefersMaxCompletionTokens('qwen3-0.6b')).toBe(false);
  });

  it('does not false-positive on gpt-500 or o-only-lookalikes', () => {
    // Substring `gpt-5` used to match `gpt-500`; the anchored regex fixes it.
    expect(prefersMaxCompletionTokens('gpt-500')).toBe(false);
    expect(prefersMaxCompletionTokens('opus-3')).toBe(false);
    expect(prefersMaxCompletionTokens('other-o3-model')).toBe(false);
  });

  it('handles provider-prefixed routes and future o<digit> SKUs', () => {
    expect(prefersMaxCompletionTokens('openai/o3-mini')).toBe(true);
    expect(prefersMaxCompletionTokens('azure/gpt-5.1')).toBe(true);
    expect(prefersMaxCompletionTokens('openrouter/openai/gpt-5.4-mini')).toBe(true);
    // Future o5/o6 must be caught by the o\d prefix, not a fixed [134] set.
    expect(prefersMaxCompletionTokens('o5-mini')).toBe(true);
    expect(prefersMaxCompletionTokens('o6-preview')).toBe(true);
  });
});

describe('openAIChatTokenLimit', () => {
  it('maps maxTokens 1:1 to max_completion_tokens for gpt-5', () => {
    // Smallest production cap today is 50 (namespace-retrieval). This is the
    // combined completion-field value — not a visible-output guarantee when
    // reasoning cannot be disabled.
    expect(openAIChatTokenLimit('gpt-5.4-mini', 50)).toEqual({
      max_completion_tokens: 50,
    });
  });

  it('uses max_tokens 1:1 for legacy models', () => {
    expect(openAIChatTokenLimit('gpt-4o-mini', 2048)).toEqual({ max_tokens: 2048 });
  });

  it('omits the limit when maxTokens is undefined', () => {
    expect(openAIChatTokenLimit('gpt-5.4-mini', undefined)).toEqual({});
  });

  it('forces max_completion_tokens on retry without inventing headroom', () => {
    expect(openAIChatTokenLimit('gpt-4o-mini', 512, true)).toEqual({
      max_completion_tokens: 512,
    });
  });
});

describe('reasoningEffortForModel / openAIReasoningParams', () => {
  it('uses none only for GPT-5.1+ chat models that document it', () => {
    expect(reasoningEffortForModel('gpt-5.1')).toBe('none');
    expect(reasoningEffortForModel('gpt-5.4-mini')).toBe('none');
    expect(openAIReasoningParams('gpt-5.4-mini')).toEqual({ reasoning_effort: 'none' });
  });

  it('uses low for gpt-5.x-codex (none unsupported despite minor >= 1)', () => {
    expect(reasoningEffortForModel('gpt-5.3-codex')).toBe('low');
    expect(openAIReasoningParams('gpt-5.3-codex')).toEqual({ reasoning_effort: 'low' });
    expect(reasoningEffortForModel('gpt-5.3-codex')).not.toBe('none');
  });

  it('uses minimal for original GPT-5 (none unsupported)', () => {
    expect(reasoningEffortForModel('gpt-5')).toBe('minimal');
    expect(reasoningEffortForModel('gpt-5-mini')).toBe('minimal');
    expect(openAIReasoningParams('gpt-5')).toEqual({ reasoning_effort: 'minimal' });
    expect(openAIReasoningParams('gpt-5').reasoning_effort).not.toBe('none');
  });

  it('uses low for older o-series and never sends none', () => {
    expect(reasoningEffortForModel('o1-preview')).toBe('low');
    expect(reasoningEffortForModel('o3-mini')).toBe('low');
    expect(reasoningEffortForModel('o4-mini')).toBe('low');
    expect(openAIReasoningParams('o3-mini')).toEqual({ reasoning_effort: 'low' });
    expect(openAIReasoningParams('o4-mini')).toEqual({ reasoning_effort: 'low' });
    for (const model of ['gpt-5', 'o3-mini', 'o4-mini'] as const) {
      expect(reasoningEffortForModel(model)).not.toBe('none');
      expect(openAIReasoningParams(model).reasoning_effort).not.toBe('none');
    }
  });

  it('treats future o-series (o5/o6) and provider-prefixed o-series as active reasoning', () => {
    // Regression: prefersMaxCompletionTokens routes these to
    // max_completion_tokens, so reasoningEffortForModel must agree they are
    // o-series. If the two disagree, the model gets sampling params (a 400)
    // and loses the empty-output guard. Both key off one o-series definition.
    for (const model of ['o5-mini', 'o6-preview', 'openai/o3-mini'] as const) {
      expect(prefersMaxCompletionTokens(model)).toBe(true);
      expect(reasoningEffortForModel(model)).toBe('low');
      expect(openAIReasoningParams(model)).toEqual({ reasoning_effort: 'low' });
      expect(openAISamplingParams(model, 0, 42)).toEqual({});
    }
  });

  it('omits effort for ChatGPT-tuned chat-latest (undocumented on model page)', () => {
    expect(reasoningEffortForModel('gpt-5.1-chat-latest')).toBeUndefined();
    expect(openAIReasoningParams('gpt-5.1-chat-latest')).toEqual({});
    expect(reasoningEffortForModel('gpt-5.1-chat-latest')).not.toBe('none');
  });

  it('omits effort for Responses-only pro SKUs', () => {
    expect(reasoningEffortForModel('gpt-5.4-pro')).toBeUndefined();
    expect(openAIReasoningParams('gpt-5.4-pro')).toEqual({});
  });

  it('omits effort for Responses-only older Codex SKUs', () => {
    for (const model of ['gpt-5-codex', 'gpt-5.1-codex'] as const) {
      expect(reasoningEffortForModel(model)).toBeUndefined();
      expect(openAIReasoningParams(model)).toEqual({});
    }
  });

  it('detects Responses-only SKUs behind a provider prefix', () => {
    // The anchored ^gpt-5 pro/codex checks must run on the prefix-stripped
    // name, or `openai/gpt-5-codex` slips through as a Chat Completions model.
    for (const model of ['openai/gpt-5-codex', 'openai/gpt-5.4-pro', 'azure/gpt-5.1-codex'] as const) {
      expect(reasoningEffortForModel(model)).toBeUndefined();
      expect(openAIReasoningParams(model)).toEqual({});
    }
  });

  it('uses low for Chat Completions Codex SKUs from gpt-5.2 onward', () => {
    for (const model of ['gpt-5.2-codex', 'gpt-5.3-codex'] as const) {
      expect(reasoningEffortForModel(model)).toBe('low');
      expect(openAIReasoningParams(model)).toEqual({ reasoning_effort: 'low' });
    }
  });

  it('omits reasoning controls for legacy models', () => {
    expect(reasoningEffortForModel('gpt-4o-mini')).toBeUndefined();
    expect(openAIReasoningParams('gpt-4o-mini')).toEqual({});
    expect(openAIReasoningParams('gpt-4o-mini', true)).toEqual({});
  });
});

describe('openAISamplingParams', () => {
  it('omits temperature and seed for actively-reasoning models (minimal/low)', () => {
    // GPT-5 family + o-series at effort minimal/low reject non-default
    // sampling controls; we must not pass them.
    for (const model of ['gpt-5', 'o3-mini', 'o4-mini', 'gpt-5.3-codex'] as const) {
      expect(openAISamplingParams(model, 0, 42)).toEqual({});
      expect(openAISamplingParams(model, undefined, undefined)).toEqual({});
    }
  });

  it('keeps temperature and seed for reasoning_effort:none models', () => {
    // 'none' disables reasoning, so these behave as standard Chat Completions
    // models and must keep the caller's determinism controls (temperature,
    // seed) rather than silently dropping them.
    for (const model of ['gpt-5.4-mini', 'gpt-5.1', 'gpt-5.1-mini'] as const) {
      expect(reasoningEffortForModel(model)).toBe('none');
      expect(openAISamplingParams(model, 0, 42)).toEqual({ temperature: 0, seed: 42 });
      expect(openAISamplingParams(model, 0.2, undefined)).toEqual({ temperature: 0.2 });
    }
  });

  it('keeps temperature (and optional seed) for ChatGPT-tuned chat-latest', () => {
    expect(openAISamplingParams('gpt-5.1-chat-latest', 0.7, 7)).toEqual({
      temperature: 0.7,
      seed: 7,
    });
  });

  it('keeps temperature (and optional seed) for legacy chat models', () => {
    expect(openAISamplingParams('gpt-4o-mini', undefined, undefined)).toEqual({
      temperature: 0,
    });
    expect(openAISamplingParams('gpt-4o-mini', 0.5, 11)).toEqual({
      temperature: 0.5,
      seed: 11,
    });
  });
});

describe('assertVisibleChatOutput', () => {
  it('returns the visible content when non-empty', () => {
    const choice = {
      message: { content: '{"ok":true}' },
      finish_reason: 'stop' as const,
    };
    expect(assertVisibleChatOutput('gpt-5.4-mini', choice)).toBe('{"ok":true}');
  });

  it('fails closed on finish_reason=length with empty content', () => {
    // An empty content on a `length` cap is a bug, not a valid downstream input.
    expect(() => assertVisibleChatOutput('gpt-4o-mini', {
      message: { content: '' },
      finish_reason: 'length',
    })).toThrow(/truncated output.*length.*empty/);
  });

  it('fails closed on finish_reason=length with a non-empty truncated prefix', () => {
    // A partial JSON prefix or half-formed namespace is not valid downstream
    // input — persisting it would silently corrupt classification/extraction.
    expect(() => assertVisibleChatOutput('gpt-4o-mini', {
      message: { content: '{"namespace":"proj/' },
      finish_reason: 'length',
    })).toThrow(/truncated output.*length.*non-empty but incomplete/);
    expect(() => assertVisibleChatOutput('gpt-5.4-mini', {
      message: { content: '{"ns":"proj/' },
      finish_reason: 'length',
    })).toThrow(/truncated output.*length.*non-empty but incomplete/);
  });

  it('fails closed on whitespace-only content for reasoning models', () => {
    // Whitespace-only visible output happens when reasoning consumes the
    // budget and the model emits nothing meaningful — treat it as empty.
    // Use an active-reasoning model (o3-mini, effort=low) so "reasoning
    // tokens" is the accurate cause.
    for (const whitespace of ['   ', '\n\n', '\t \n']) {
      expect(() => assertVisibleChatOutput('o3-mini', {
        message: { content: whitespace },
        finish_reason: 'stop',
      })).toThrow(/reasoning tokens/);
    }
  });

  it('fails closed for reasoning models when content is empty even on stop', () => {
    // Reasoning consuming the whole budget can surface as
    // finish_reason=stop with empty content on some SDKs.
    expect(() => assertVisibleChatOutput('o3-mini', {
      message: { content: null },
      finish_reason: 'stop',
    })).toThrow(/reasoning tokens/);
  });

  it('returns empty (not fail-closed) for reasoning_effort:none models on stop', () => {
    // 'none' disables reasoning, so gpt-5.1+ base/mini behave like standard
    // Chat Completions models: an empty `stop` response is returned as-is,
    // not blamed on a reasoning budget it never spent. (Truncation, i.e.
    // finish_reason=length, still fails closed for every model.)
    expect(assertVisibleChatOutput('gpt-5.4-mini', {
      message: { content: '' },
      finish_reason: 'stop',
    })).toBe('');
    expect(assertVisibleChatOutput('gpt-5.4-mini', {
      message: { content: '   ' },
      finish_reason: 'stop',
    })).toBe('   ');
  });

  it('does not error on empty content for legacy models when not truncated', () => {
    // Do not add a new fail-closed for legacy paths that never had it.
    expect(assertVisibleChatOutput('gpt-4o-mini', {
      message: { content: '' },
      finish_reason: 'stop',
    })).toBe('');
    // Whitespace-only on a legacy path with `stop` is still allowed —
    // downstream tests can normalize it; only reasoning/length paths
    // gain the new fail-closed contract.
    expect(assertVisibleChatOutput('gpt-4o-mini', {
      message: { content: '   ' },
      finish_reason: 'stop',
    })).toBe('   ');
  });
});

describe('isMaxTokensUnsupportedError structured shape', () => {
  it('recognizes an OpenAI APIError-shape via code/param', () => {
    const err = Object.assign(new Error('unsupported'), {
      code: 'unsupported_parameter',
      param: 'max_tokens',
    });
    expect(isMaxTokensUnsupportedError(err)).toBe(true);
  });

  it('recognizes when code/param live under the nested `error` payload', () => {
    const err = Object.assign(new Error('unsupported'), {
      error: { code: 'unsupported_parameter', param: 'max_tokens' },
    });
    expect(isMaxTokensUnsupportedError(err)).toBe(true);
  });

  it('does not match unrelated unsupported params', () => {
    const err = Object.assign(new Error('unsupported'), {
      code: 'unsupported_parameter',
      param: 'temperature',
    });
    expect(isMaxTokensUnsupportedError(err)).toBe(false);
  });

  it('still recognizes substring-only errors from compatible backends', () => {
    // OpenAI-compatible servers may not surface structured code/param;
    // the substring fallback keeps the retry classifier working there.
    expect(isMaxTokensUnsupportedError(
      new Error("Unsupported parameter: 'max_tokens' ... 'max_completion_tokens'"),
    )).toBe(true);
  });
});

describe('tryApplyOpenAIRetry / OPENAI_CHAT_MAX_ATTEMPTS', () => {
  it('exposes a bounded retry budget of exactly three attempts', () => {
    // Whole retry contract keys off this constant; if it grows without a
    // matching contract update, the composed mitigations lose their
    // bounded guarantee.
    expect(OPENAI_CHAT_MAX_ATTEMPTS).toBe(3);
  });

  it('applies each mitigation at most once and returns false when exhausted', () => {
    const state: OpenAIRetryState = { aggressiveSanitize: false, forceMaxCompletionTokens: false };
    const parseErr = new Error('Could not parse the JSON body of your request');
    const tokenErr = Object.assign(new Error('unsupported'), {
      code: 'unsupported_parameter',
      param: 'max_tokens',
    });
    expect(isJsonBodyParseError(parseErr)).toBe(true);
    expect(isMaxTokensUnsupportedError(tokenErr)).toBe(true);
    expect(tryApplyOpenAIRetry(parseErr, state)).toBe(true);
    expect(state.aggressiveSanitize).toBe(true);
    expect(tryApplyOpenAIRetry(parseErr, state)).toBe(false);
    expect(tryApplyOpenAIRetry(tokenErr, state)).toBe(true);
    expect(state.forceMaxCompletionTokens).toBe(true);
    expect(tryApplyOpenAIRetry(tokenErr, state)).toBe(false);
    expect(tryApplyOpenAIRetry(new Error('other'), state)).toBe(false);
  });
});

describe('assertOpenAIChatCompletionsModel', () => {
  it('rejects Responses-only OpenAI Pro and older Codex SKUs', () => {
    for (const model of ['gpt-5.4-pro', 'gpt-5-codex', 'gpt-5.1-codex'] as const) {
      expect(() => assertOpenAIChatCompletionsModel(model)).toThrow(/Responses API only/);
    }
  });

  it('rejects Responses-only SKUs behind a provider prefix', () => {
    // Regression: the anchored ^gpt-5 pro/codex checks must strip the
    // provider prefix, or `openai/gpt-5-codex` is wrongly allowed.
    for (const model of ['openai/gpt-5-codex', 'openai/gpt-5.4-pro', 'azure/gpt-5.1-codex'] as const) {
      expect(() => assertOpenAIChatCompletionsModel(model)).toThrow(/Responses API only/);
    }
  });

  it('allows Chat Completions Codex SKUs from gpt-5.2 onward', () => {
    for (const model of ['gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.4-mini'] as const) {
      expect(() => assertOpenAIChatCompletionsModel(model)).not.toThrow();
    }
  });
});
