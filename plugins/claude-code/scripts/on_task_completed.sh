#!/usr/bin/env bash
# Hook: TaskCompleted
#
# Fires when a task is marked completed. Stores a compact deterministic
# task record directly; does not block task completion.
#
# Input:  JSON on stdin with task_id, task_subject, optional
#         task_description / teammate_name / team_name, plus common fields.
# Output: none.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/atomicmemory.sh
if ! . "$SCRIPT_DIR/lib/atomicmemory.sh"; then
  printf '[atomicmemory-hook] failed to load helper library\n' >&2
  exit 1
fi

am_load_env || exit 1

INPUT=$(cat)

TASK_ID=$(echo "$INPUT" | jq -r '.task_id // ""' 2>/dev/null || echo "")
TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject // .task_title // .subject // ""' 2>/dev/null || echo "")
TASK_DESCRIPTION=$(echo "$INPUT" | jq -r '.task_description // ""' 2>/dev/null || echo "")
TEAMMATE_NAME=$(echo "$INPUT" | jq -r '.teammate_name // ""' 2>/dev/null || echo "")
TEAM_NAME=$(echo "$INPUT" | jq -r '.team_name // ""' 2>/dev/null || echo "")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
CWD_VALUE=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")

TASK_SUBJECT=$(am_clean_inline_text "$(printf '%s' "$TASK_SUBJECT" | tr -cd '[:print:]\n')" 160)

if [ -z "$TASK_SUBJECT" ] || [ "$TASK_SUBJECT" = "unknown task" ]; then
  am_debug "TaskCompleted missing task_subject"
  exit 0
fi

if [ -z "$TASK_ID" ]; then
  TASK_ID=$(am_dedupe_key "$SESSION_ID" "task_completed_subject" "$TASK_SUBJECT")
fi

TOOL_COUNT=0
if [ -n "$TRANSCRIPT_PATH" ] && [ -r "$TRANSCRIPT_PATH" ]; then
  TOOL_COUNT=$(tail -n 500 "$TRANSCRIPT_PATH" 2>/dev/null |
    jq -r 'select(.type == "assistant") | .message.content[]? | select(type == "object" and .type == "tool_use") | .name' 2>/dev/null |
    wc -l | tr -d ' ')
fi

THRESHOLD=$(am_positive_int ATOMICMEMORY_TASK_MIN_TOOL_CALLS 5) || exit 1

if [ "$AM_CAPTURE_LEVEL" = "minimal" ] && [ "${TOOL_COUNT:-0}" -le "$THRESHOLD" ]; then
  am_debug "TaskCompleted skipped by minimal capture level"
  exit 0
fi

DEDUPE_KEY=$(am_dedupe_key "$SESSION_ID" "task_completed" "$TASK_ID")

METADATA=$(jq -n \
  --arg source "claude-code" \
  --arg event "task_completed" \
  --arg task_id "$TASK_ID" \
  --arg task_subject "$TASK_SUBJECT" \
  --arg teammate_name "$TEAMMATE_NAME" \
  --arg team_name "$TEAM_NAME" \
  --arg session_id "$SESSION_ID" \
  --arg cwd "$CWD_VALUE" \
  --arg transcript_path "$TRANSCRIPT_PATH" \
  --arg dedupe_key "$DEDUPE_KEY" \
  --argjson tool_count "${TOOL_COUNT:-0}" \
  '{
    source: $source,
    event: $event,
    task_id: $task_id,
    task_subject: $task_subject,
    teammate_name: $teammate_name,
    team_name: $team_name,
    session_id: $session_id,
    cwd: $cwd,
    transcript_path: $transcript_path,
    tool_count: $tool_count,
    dedupe_key: $dedupe_key,
    schema_version: 1
  }') || exit 1

CONTENT="$TASK_SUBJECT"

if [ -n "$TASK_DESCRIPTION" ]; then
  TASK_MAX_DESCRIPTION_CHARS=$(am_positive_int ATOMICMEMORY_TASK_MAX_DESCRIPTION_CHARS 600) || exit 1
  TASK_DESCRIPTION=$(am_clean_summary_text "$(am_redact_secrets "$TASK_DESCRIPTION")" "$TASK_MAX_DESCRIPTION_CHARS")
  if [ -n "$TASK_DESCRIPTION" ]; then
    CONTENT=$(printf '%s\n\n%s' "$CONTENT" "$TASK_DESCRIPTION")
  fi
fi

am_ingest_verbatim "$CONTENT" "$METADATA" "$DEDUPE_KEY" >/dev/null || exit 1
am_touch_lastwrite "$SESSION_ID" >/dev/null || exit 1

exit 0
