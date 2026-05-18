#!/usr/bin/env bash
# Hook: Stop
#
# Fires when Claude finishes responding. Writes a compact deterministic
# session record for meaningful turns, then optionally prompts Claude for
# semantic memories.
#
# Input:  JSON on stdin with stop_hook_active, transcript_path, cwd,
#         optional last_assistant_message.
# Output: Optional JSON {"decision":"block","reason":"..."} for semantic
#         learning extraction.
#
# Checks stop_hook_active to avoid infinite loops (Claude's own
# acknowledgement of this prompt would otherwise re-trigger Stop).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/atomicmemory.sh
if ! . "$SCRIPT_DIR/lib/atomicmemory.sh"; then
  printf '[atomicmemory-hook] failed to load helper library\n' >&2
  exit 1
fi

am_load_env || exit 1

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")

if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

if [ "$AM_CAPTURE_LEVEL" = "minimal" ]; then
  exit 0
fi

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
CWD_VALUE=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
LAST_ASSISTANT=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null || echo "")

MESSAGE_COUNT=0
FILES_TOUCHED=""
TOOLS_RUN=""
TEST_COMMANDS=""
HAS_COMPLETED_TASK=0

if [ -n "$TRANSCRIPT_PATH" ] && [ -r "$TRANSCRIPT_PATH" ]; then
  MESSAGE_COUNT=$(wc -l <"$TRANSCRIPT_PATH" 2>/dev/null | tr -d ' ' || echo 0)

  if [ -z "$LAST_ASSISTANT" ]; then
    LAST_ASSISTANT=$(tail -n 200 "$TRANSCRIPT_PATH" 2>/dev/null |
      jq -r 'select(.type == "assistant") | .message.content[]? | select(type == "object" and .type == "text") | .text' 2>/dev/null |
      tail -n 1)
  fi

  FILES_TOUCHED=$(tail -n 500 "$TRANSCRIPT_PATH" 2>/dev/null |
    jq -r '
      select(.type == "assistant")
      | .message.content[]?
      | select(type == "object" and .type == "tool_use")
      | select(.name == "Write" or .name == "Edit" or .name == "MultiEdit" or .name == "NotebookEdit")
      | (.input.file_path // .input.path // empty)
    ' 2>/dev/null | sort -u | head -n 20)

  TOOLS_RUN=$(tail -n 500 "$TRANSCRIPT_PATH" 2>/dev/null |
    jq -r '
      select(.type == "assistant")
      | .message.content[]?
      | select(type == "object" and .type == "tool_use")
      | .name
    ' 2>/dev/null | sort | uniq -c | sed -E 's/^ *//' | head -n 20)

  TEST_COMMANDS=$(tail -n 500 "$TRANSCRIPT_PATH" 2>/dev/null |
    jq -r '
      select(.type == "assistant")
      | .message.content[]?
      | select(type == "object" and .type == "tool_use" and .name == "Bash")
      | (.input.command // "")
      | select(test("(^|[[:space:];&|])(npm|pnpm|yarn) (run )?test($|[[:space:];&|])|pytest|cargo test|go test|make test"))
    ' 2>/dev/null | head -n 10)

  if tail -n 500 "$TRANSCRIPT_PATH" 2>/dev/null |
    jq -e '
      select(.type == "assistant")
      | .message.content[]?
      | select(type == "object" and .type == "tool_use")
      | select(.name == "TaskUpdate" or .name == "TodoWrite")
      | select((.input.status? == "completed") or ((.input.todos? // []) | any(.status == "completed")))
    ' >/dev/null 2>&1; then
    HAS_COMPLETED_TASK=1
  fi
fi

LAST_ASSISTANT=$(am_redact_secrets "$LAST_ASSISTANT")
STOP_MAX_SUMMARY_CHARS=$(am_positive_int ATOMICMEMORY_STOP_MAX_SUMMARY_CHARS 600) || exit 1
LAST_ASSISTANT=$(am_clean_summary_text "$LAST_ASSISTANT" "$STOP_MAX_SUMMARY_CHARS")

MIN_ASSISTANT_CHARS=$(am_positive_int ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS 200) || exit 1

HAS_STRUCTURAL_SIGNAL=0
if [ -n "$FILES_TOUCHED" ] || [ -n "$TEST_COMMANDS" ] || [ "$HAS_COMPLETED_TASK" = "1" ]; then
  HAS_STRUCTURAL_SIGNAL=1
fi

SHOULD_WRITE=0
if [ "$AM_CAPTURE_LEVEL" = "full" ] && [ ${#LAST_ASSISTANT} -ge "$MIN_ASSISTANT_CHARS" ]; then
  SHOULD_WRITE=1
elif [ "$HAS_STRUCTURAL_SIGNAL" = "1" ] && [ ${#LAST_ASSISTANT} -ge "$MIN_ASSISTANT_CHARS" ]; then
  SHOULD_WRITE=1
fi

if [ "$SHOULD_WRITE" = "1" ]; then
  DEDUPE_KEY=$(am_dedupe_key "$SESSION_ID" "stop" "$MESSAGE_COUNT")
  FILES_TOUCHED_REL=$(am_relative_lines "$FILES_TOUCHED" "$CWD_VALUE")
  FILES_TOUCHED_JSON=$(am_json_array_from_lines "$FILES_TOUCHED_REL") || exit 1
  TOOLS_RUN_JSON=$(am_json_array_from_lines "$TOOLS_RUN") || exit 1
  TEST_COMMANDS_JSON=$(am_json_array_from_lines "$TEST_COMMANDS") || exit 1

  METADATA=$(jq -n \
    --arg source "claude-code" \
    --arg event "stop" \
    --arg session_id "$SESSION_ID" \
    --arg cwd "$CWD_VALUE" \
    --arg transcript_path "$TRANSCRIPT_PATH" \
    --arg dedupe_key "$DEDUPE_KEY" \
    --argjson message_count "${MESSAGE_COUNT:-0}" \
    --argjson files_touched "$FILES_TOUCHED_JSON" \
    --argjson tools_run "$TOOLS_RUN_JSON" \
    --argjson test_commands "$TEST_COMMANDS_JSON" \
    '{
      source: $source,
      event: $event,
      session_id: $session_id,
      cwd: $cwd,
      transcript_path: $transcript_path,
      message_count: $message_count,
      files_touched: $files_touched,
      tools_run: $tools_run,
      test_commands: $test_commands,
      dedupe_key: $dedupe_key,
      schema_version: 1
    }') || exit 1

  CONTENT="$LAST_ASSISTANT"

  am_ingest_verbatim "$CONTENT" "$METADATA" "$DEDUPE_KEY" >/dev/null || exit 1
  am_touch_lastwrite "$SESSION_ID" >/dev/null || exit 1
fi

if [ "$SHOULD_WRITE" = "1" ]; then
  am_flag_enabled ATOMICMEMORY_SEMANTIC_PROMPTS_ENABLED true
  FLAG_STATUS=$?
  [ "$FLAG_STATUS" -eq 2 ] && exit 1
  [ "$FLAG_STATUS" -eq 1 ] && exit 0
  jq -Rs '{decision: "block", reason: .}' <<'REASON_EOF' || exit 1
Before finishing, store only durable learnings from this interaction via `memory_ingest`:

1. Decisions that should survive across sessions. Prefix with "Decision:".
2. User preferences that should apply later. Prefix with "Preference:".
3. Failed approaches worth avoiding. Prefix with "Anti-pattern:".

Skip if there is nothing durable to save.
REASON_EOF
fi

exit 0
