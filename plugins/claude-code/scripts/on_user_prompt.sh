#!/usr/bin/env bash
# Hook: UserPromptSubmit
#
# Fires on every user message. Searches AtomicMemory for memories
# relevant to the prompt and injects them as context before the
# model turn, saving the agent a tool-call roundtrip.
#
# Input:  JSON on stdin with prompt, session_id, cwd, transcript_path
# Output: JSON additionalContext when memories match (exit 0)
#
# Skips search for short prompts or explicit opt-out. Configuration and
# runtime failures are surfaced instead of silently degrading.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/atomicmemory.sh
if ! . "$SCRIPT_DIR/lib/atomicmemory.sh"; then
  printf '[atomicmemory-hook] failed to load helper library\n' >&2
  exit 1
fi

am_load_env || exit 1

am_flag_enabled ATOMICMEMORY_PROMPT_SEARCH_ENABLED true
FLAG_STATUS=$?
if [ "$FLAG_STATUS" -eq 2 ]; then
  exit 1
fi
if [ "$FLAG_STATUS" -eq 1 ]; then
  am_debug "prompt search disabled"
  exit 0
fi

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null || echo "")

MIN_CHARS=$(am_positive_int ATOMICMEMORY_PROMPT_SEARCH_MIN_CHARS 20) || exit 1

# Skip trivial prompts; not worth a network call.
if [ ${#PROMPT} -lt "$MIN_CHARS" ]; then
  exit 0
fi

PROMPT_SEARCH_LIMIT=$(am_positive_int ATOMICMEMORY_PROMPT_SEARCH_LIMIT 5) || exit 1
RESPONSE=$(am_search_fast "$PROMPT" "$PROMPT_SEARCH_LIMIT") || exit 1

if [ -z "$RESPONSE" ]; then
  exit 0
fi

# Sanitize and budget the retrieved memories before injecting them as
# model context. `am_build_prompt_context` strips model chain-of-thought
# blocks, redacts secrets, flattens newlines (so a poisoned memory cannot
# inject a fake instruction bullet), and enforces per-hit + total char
# caps — matching the bundled Node runtime's `sanitizePromptContext`
# contract. Raw `jq` extraction here previously bypassed all of it.
PER_HIT_CHARS=$(am_positive_int ATOMICMEMORY_PROMPT_CONTEXT_PER_HIT_CHARS 800) || exit 1
TOTAL_CHARS=$(am_positive_int ATOMICMEMORY_PROMPT_CONTEXT_TOTAL_CHARS 4000) || exit 1
MEMORIES=$(am_build_prompt_context "$RESPONSE" "$PER_HIT_CHARS" "$TOTAL_CHARS") || exit 1

if [ -n "$MEMORIES" ]; then
  jq -n \
    --arg context "$MEMORIES" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $context}}' \
    2>/dev/null || echo "$MEMORIES"
fi

exit 0
