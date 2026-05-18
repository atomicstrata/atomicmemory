#!/usr/bin/env bash
# Hook: PostCompact
#
# Captures Claude Code's platform-generated compact_summary after
# compaction. This hook does not block or guide the model; it performs a
# deterministic side-effect write and surfaces configuration/runtime errors.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/atomicmemory.sh
if ! . "$SCRIPT_DIR/lib/atomicmemory.sh"; then
  printf '[atomicmemory-hook] failed to load helper library\n' >&2
  exit 1
fi

am_load_env || exit 1

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
CWD_VALUE=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"' 2>/dev/null || echo "unknown")
SUMMARY=$(echo "$INPUT" | jq -r '.compact_summary // ""' 2>/dev/null || echo "")

if [ -z "$SUMMARY" ]; then
  am_debug "PostCompact compact_summary empty"
  exit 0
fi

SUMMARY=$(am_redact_secrets "$SUMMARY")
SUMMARY_HASH=$(am_dedupe_key "$SUMMARY" "" "")
DEDUPE_KEY=$(am_dedupe_key "$SESSION_ID" "post_compact" "$TRIGGER|$SUMMARY_HASH")
COMPACT_MAX_SUMMARY_CHARS=$(am_positive_int ATOMICMEMORY_COMPACT_MAX_SUMMARY_CHARS 2400) || exit 1
SUMMARY=$(am_clean_compact_summary_text "$SUMMARY" "$COMPACT_MAX_SUMMARY_CHARS")
if [ -z "$SUMMARY" ]; then
  am_debug "PostCompact compact_summary empty after cleanup"
  exit 0
fi

METADATA=$(jq -n \
  --arg source "claude-code" \
  --arg event "post_compact" \
  --arg trigger "$TRIGGER" \
  --arg session_id "$SESSION_ID" \
  --arg cwd "$CWD_VALUE" \
  --arg transcript_path "$TRANSCRIPT_PATH" \
  --arg dedupe_key "$DEDUPE_KEY" \
  '{
    source: $source,
    event: $event,
    trigger: $trigger,
    session_id: $session_id,
    cwd: $cwd,
    transcript_path: $transcript_path,
    dedupe_key: $dedupe_key,
    schema_version: 1
  }') || exit 1

CONTENT="$SUMMARY"

am_ingest_verbatim "$CONTENT" "$METADATA" "$DEDUPE_KEY" >/dev/null || exit 1
am_touch_lastwrite "$SESSION_ID" >/dev/null || exit 1

exit 0
