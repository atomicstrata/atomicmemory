#!/usr/bin/env bash
# Hook: PreCompact
#
# Deliberately no-op. Claude Code treats PreCompact blocking as
# "skip compaction", so this hook must not prompt the model or return
# decision:block. Deterministic compaction capture happens after
# compaction through PostCompact.compact_summary.
#
# Input:  JSON on stdin with trigger, session_id, transcript_path, cwd.
# Output: none.

set -uo pipefail

if [ "${ATOMICMEMORY_DEBUG:-}" = "1" ]; then
  printf '[atomicmemory-hook] PreCompact no-op; PostCompact will capture compact_summary\n' >&2
fi

exit 0
