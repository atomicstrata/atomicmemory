#!/usr/bin/env bash

# Shared helpers for Claude Code lifecycle hooks. Callers should surface
# configuration and runtime failures instead of silently running degraded.

am_debug() {
  if [ "${ATOMICMEMORY_DEBUG:-}" = "1" ]; then
    printf '[atomicmemory-hook] %s\n' "$*" >&2
  fi
}

am_require() {
  command -v "$1" >/dev/null 2>&1
}

am_default_scope_user() {
  if [ -n "${USER:-}" ]; then
    printf '%s' "$USER"
    return 0
  fi
  if am_require id; then
    id -un 2>/dev/null && return 0
  fi
  if am_require whoami; then
    whoami 2>/dev/null && return 0
  fi
  if am_require hostname; then
    hostname 2>/dev/null && return 0
  fi
  printf 'local-machine'
}

am_load_env() {
  am_require jq || {
    am_debug "jq not found"
    return 1
  }
  am_require curl || {
    am_debug "curl not found"
    return 1
  }

  AM_PROVIDER="${ATOMICMEMORY_PROVIDER:-atomicmemory}"
  AM_API_URL="${ATOMICMEMORY_API_URL:-http://127.0.0.1:3050}"
  AM_API_KEY="${ATOMICMEMORY_API_KEY:-}"
  AM_SCOPE_USER="${ATOMICMEMORY_SCOPE_USER:-$(am_default_scope_user)}"
  AM_SCOPE_AGENT="${ATOMICMEMORY_SCOPE_AGENT:-}"
  AM_SCOPE_NAMESPACE="${ATOMICMEMORY_SCOPE_NAMESPACE:-}"
  AM_SCOPE_THREAD="${ATOMICMEMORY_SCOPE_THREAD:-}"
  AM_CAPTURE_LEVEL="${ATOMICMEMORY_CAPTURE_LEVEL:-balanced}"

  AM_API_URL="${AM_API_URL%/}"

  if [ -z "$AM_API_URL" ] || [ -z "$AM_SCOPE_USER" ] || [ -z "$AM_PROVIDER" ] || [ -z "$AM_CAPTURE_LEVEL" ]; then
    am_debug "missing local scope user, ATOMICMEMORY_PROVIDER, or ATOMICMEMORY_CAPTURE_LEVEL"
    return 1
  fi

  if [ "$AM_PROVIDER" != "atomicmemory" ]; then
    am_debug "Claude Code lifecycle hooks require ATOMICMEMORY_PROVIDER=atomicmemory"
    return 1
  fi

  case "$AM_CAPTURE_LEVEL" in
    minimal|balanced|full) ;;
    *)
      am_debug "ATOMICMEMORY_CAPTURE_LEVEL must be one of minimal, balanced, full"
      return 1
      ;;
  esac

  return 0
}

am_positive_int() {
  local name="$1"
  local default_value="$2"
  local value
  eval "value=\"\${$name:-}\""

  if [ -z "$value" ]; then
    printf '%s' "$default_value"
    return 0
  fi

  case "$value" in
    ''|*[!0-9]*|0)
      am_debug "$name must be a positive integer"
      return 1
      ;;
    *)
      printf '%s' "$value"
      return 0
      ;;
  esac
}

am_flag_enabled() {
  local name="$1"
  local default_value="$2"
  local value
  eval "value=\"\${$name:-}\""

  if [ -z "$value" ]; then
    value="$default_value"
  fi

  case "$value" in
    true) return 0 ;;
    false) return 1 ;;
    *)
      am_debug "$name must be true or false"
      return 2
      ;;
  esac
}

am_scope_json() {
  jq -n \
    --arg user "$AM_SCOPE_USER" \
    --arg agent "$AM_SCOPE_AGENT" \
    --arg namespace "$AM_SCOPE_NAMESPACE" \
    --arg thread "$AM_SCOPE_THREAD" \
    '{}
     + (if $user != "" then {user: $user} else {} end)
     + (if $agent != "" then {agent: $agent} else {} end)
     + (if $namespace != "" then {namespace: $namespace} else {} end)
     + (if $thread != "" then {thread: $thread} else {} end)'
}

am_auth_curl_args() {
  # Populate the global AM_AUTH_CURL_ARGS array with the Bearer
  # auth header pair when AM_API_KEY is set, or leave it empty.
  # Matches the SDK's wire convention and core's `requireBearer`
  # middleware (`Authorization: Bearer <key>`). Callers expand
  # with `${AM_AUTH_CURL_ARGS[@]+"${AM_AUTH_CURL_ARGS[@]}"}` so the
  # empty-array case is safe under `set -u` on bash 3.2.
  AM_AUTH_CURL_ARGS=()
  if [ -n "${AM_API_KEY:-}" ]; then
    AM_AUTH_CURL_ARGS=("-H" "Authorization: Bearer $AM_API_KEY")
  fi
}

am_search_fast() {
  local query="${1:-}"
  local limit="${2:-5}"

  if [ "$AM_PROVIDER" != "atomicmemory" ]; then
    am_debug "direct search skipped for provider=$AM_PROVIDER"
    return 1
  fi

  if [ -z "$query" ]; then
    return 1
  fi

  local body
  body=$(jq -n \
    --arg query "$query" \
    --arg user_id "$AM_SCOPE_USER" \
    --arg namespace "$AM_SCOPE_NAMESPACE" \
    --argjson limit "$limit" \
    '{user_id: $user_id, query: $query, limit: $limit}
     + (if $namespace != "" then {namespace_scope: $namespace} else {} end)') || return 1

  local timeout_seconds
  timeout_seconds=$(am_positive_int ATOMICMEMORY_SEARCH_TIMEOUT_SECONDS 3) || return 1

  am_auth_curl_args
  curl -s --max-time "$timeout_seconds" \
    -X POST "$AM_API_URL/v1/memories/search/fast" \
    -H "Content-Type: application/json" \
    ${AM_AUTH_CURL_ARGS[@]+"${AM_AUTH_CURL_ARGS[@]}"} \
    -d "$body"
}

am_cache_dir() {
  if [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s/atomicmemory' "$XDG_CACHE_HOME"
  elif [ -n "${HOME:-}" ]; then
    printf '%s/.cache/atomicmemory' "$HOME"
  else
    printf '/tmp/atomicmemory-cache'
  fi
}

am_safe_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'
}

am_dedupe_key() {
  local raw="${1:-}|${2:-}|${3:-}"
  if am_require shasum; then
    printf '%s' "$raw" | shasum -a 256 | awk '{print $1}'
  elif am_require sha256sum; then
    printf '%s' "$raw" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$raw" | cksum | awk '{print $1}'
  fi
}

am_dedupe_seen() {
  local key
  key=$(am_safe_name "$1")
  [ -f "$(am_cache_dir)/dedupe-$key" ]
}

am_mark_dedupe() {
  local key
  key=$(am_safe_name "$1")
  mkdir -p "$(am_cache_dir)" 2>/dev/null || return 1
  date +%s >"$(am_cache_dir)/dedupe-$key" 2>/dev/null || return 1
}

am_touch_lastwrite() {
  local session_id
  session_id=$(am_safe_name "${1:-unknown}")
  mkdir -p "$(am_cache_dir)" 2>/dev/null || return 1
  date +%s >"$(am_cache_dir)/session-$session_id.lastwrite" 2>/dev/null || return 1
}

am_lastwrite_fresh() {
  local session_id
  local max_age
  local path
  local now
  local then

  session_id=$(am_safe_name "${1:-unknown}")
  max_age="${2:-60}"
  path="$(am_cache_dir)/session-$session_id.lastwrite"
  [ -f "$path" ] || return 1

  now=$(date +%s)
  then=$(cat "$path" 2>/dev/null || echo 0)
  [ $((now - then)) -le "$max_age" ]
}

am_redact_secrets() {
  printf '%s' "${1:-}" |
    sed -E \
      -e 's#https?://[^/@[:space:]]+:[^/@[:space:]]+@#https://[redacted]@#g' \
      -e 's#sk-[A-Za-z0-9_-]{16,}#sk-[redacted]#g' \
      -e 's#AKIA[0-9A-Z]{16}#AKIA[redacted]#g' \
      -e 's#[A-Z0-9_]{32,}#[redacted-token]#g'
}

am_truncate() {
  local text="${1:-}"
  local max="${2:-1500}"
  if [ "${#text}" -gt "$max" ]; then
    local clipped="${text:0:max}"
    if [[ "$clipped" == *" "* ]]; then
      clipped="${clipped% *}"
    fi
    printf '%s...' "$clipped"
  else
    printf '%s' "$text"
  fi
}

am_clean_inline_text() {
  local text="${1:-}"
  local max="${2:-160}"

  printf '%s' "$text" |
    tr '\n' ' ' |
    sed -E \
      -e 's/<\/?[A-Za-z][A-Za-z0-9_:-]*[^>]*>//g' \
      -e 's/\*\*//g' \
      -e 's/__//g' \
      -e 's/`//g' \
      -e 's/[[:space:]]+/ /g' \
      -e 's/^ //' \
      -e 's/ $//' |
    {
      local cleaned
      cleaned=$(cat)
      am_truncate "$cleaned" "$max"
    }
}

am_clean_summary_text() {
  local text="${1:-}"
  local max="${2:-900}"

  printf '%s' "$text" |
    awk '
      function trim(value) {
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        return value
      }
      /^[[:space:]]*```/ { in_code = !in_code; next }
      in_code { next }
      {
        line = trim($0)
        if (line == "") next
        lower = tolower(line)
        if (lower ~ /^[[:space:]]*(want me to|do you want me to|would you like me to|if you want|let me know if|should i)[[:space:]]/) next
        if (lower ~ /^[[:space:]]*(want me to|do you want me to|would you like me to|if you want|let me know if|should i)[?!.]*[[:space:]]*$/) next
        if (line ~ /^#{1,6}[[:space:]]+/) sub(/^#{1,6}[[:space:]]+/, "", line)
        gsub(/\*\*/, "", line)
        gsub(/__/, "", line)
        gsub(/`/, "", line)
        gsub(/[Hh]ere.s what I found:$/, "", line)
        sub(/^[[:space:]]*[-*][[:space:]]+/, "", line)
        sub(/^[[:space:]]*[0-9]+[.)][[:space:]]+/, "", line)
        gsub(/[[:space:]]+/, " ", line)
        line = trim(line)
        if (line ~ /^[A-Za-z][A-Za-z0-9 _-]+ *\(.*\):$/ && length(line) < 140) next
        if (line ~ /:$/ && length(line) < 80 && line !~ /[.!?]/) next
        if (tolower(line) ~ /^(example|evidence):$/) next
        if (out != "") out = out " "
        out = out line
      }
      END { print out }
    ' |
    sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' |
    {
      local cleaned
      cleaned=$(cat)
      am_truncate "$cleaned" "$max"
    }
}

am_clean_compact_summary_text() {
  local text="${1:-}"
  local max="${2:-2400}"
  local extracted

  extracted=$(printf '%s' "$text" |
    awk '
      BEGIN {
        analysis_open = "<analysis>"
        analysis_close = "</analysis>"
        summary_open = "<summary>"
        summary_close = "</summary>"
      }
      {
        text = text $0 "\n"
      }
      END {
        lower = tolower(text)
        while ((start = index(lower, analysis_open)) > 0) {
          close_rel = index(substr(lower, start), analysis_close)
          if (close_rel == 0) {
            text = substr(text, 1, start - 1)
            break
          }
          close_abs = start + close_rel - 1
          after_close = close_abs + length(analysis_close)
          text = substr(text, 1, start - 1) substr(text, after_close)
          lower = tolower(text)
        }

        lower = tolower(text)
        start = index(lower, summary_open)
        if (start > 0) {
          content_start = start + length(summary_open)
          close_rel = index(substr(lower, content_start), summary_close)
          if (close_rel > 0) {
            text = substr(text, content_start, close_rel - 1)
          } else {
            text = substr(text, content_start)
          }
        }

        gsub(/<\/?[A-Za-z][A-Za-z0-9_:-]*[^>]*>/, "", text)
        printf "%s", text
      }
    ')

  am_clean_summary_text "$extracted" "$max"
}

am_relative_lines() {
  local lines="${1:-}"
  local base="${2:-}"
  local line

  if [ -z "$lines" ]; then
    return 0
  fi

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ -n "$base" ]; then
      case "$line" in
        "$base"/*) line="${line#"$base"/}" ;;
      esac
    fi
    printf '%s\n' "$line"
  done <<EOF
$lines
EOF
}

am_bullet_lines() {
  local lines="${1:-}"
  local empty="${2:-none}"
  local line

  if [ -z "$lines" ]; then
    printf -- '- %s\n' "$empty"
    return 0
  fi

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    printf -- '- %s\n' "$line"
  done <<EOF
$lines
EOF
}

am_json_array_from_lines() {
  local lines="${1:-}"
  if [ -z "$lines" ]; then
    printf '[]'
    return 0
  fi

  printf '%s\n' "$lines" | jq -R -s 'split("\n") | map(select(length > 0))'
}

am_lifecycle_source_url() {
  local dedupe_key="${1:-}"
  local source_url="atomicmemory://claude-code"
  if [ -n "$dedupe_key" ]; then
    source_url="$source_url/$dedupe_key"
  fi
  printf '%s' "$source_url"
}

am_quick_ingest_body() {
  local content="${1:-}"
  local source_url="${2:-}"
  local metadata_json="${3:-}"

  # Treat absent and the literal '{}' as no-metadata so non-hook
  # callers don't emit a stray empty `metadata` field on the wire.
  if [ -z "$metadata_json" ] || [ "$metadata_json" = '{}' ]; then
    jq -n \
      --arg user_id "$AM_SCOPE_USER" \
      --arg conversation "$content" \
      --arg source_url "$source_url" \
      '{
        user_id: $user_id,
        conversation: $conversation,
        source_site: "claude-code",
        source_url: $source_url,
        skip_extraction: true
      }'
  else
    # Validate the caller's metadata is parseable JSON BEFORE
    # building the body. Per CLAUDE.md "no fallback values":
    # malformed input fails loudly instead of silently substituting
    # a default.
    if ! printf '%s' "$metadata_json" | jq empty >/dev/null 2>&1; then
      printf '[atomicmemory] am_quick_ingest_body: metadata_json is not valid JSON\n' >&2
      return 1
    fi
    jq -n \
      --arg user_id "$AM_SCOPE_USER" \
      --arg conversation "$content" \
      --arg source_url "$source_url" \
      --argjson metadata "$metadata_json" \
      '{
        user_id: $user_id,
        conversation: $conversation,
        source_site: "claude-code",
        source_url: $source_url,
        skip_extraction: true,
        metadata: $metadata
      }'
  fi
}

am_post_quick_ingest() {
  local body="${1:-}"
  local http_code
  local timeout_seconds
  timeout_seconds=$(am_positive_int ATOMICMEMORY_WRITE_TIMEOUT_SECONDS 8) || return 1
  am_auth_curl_args
  http_code=$(curl -sS --max-time "$timeout_seconds" \
    -o /dev/null \
    -w "%{http_code}" \
    -X POST "$AM_API_URL/v1/memories/ingest/quick" \
    -H "Content-Type: application/json" \
    ${AM_AUTH_CURL_ARGS[@]+"${AM_AUTH_CURL_ARGS[@]}"} \
    -d "$body") || return 1

  case "$http_code" in
    200|201) return 0 ;;
    *)
      am_debug "quick ingest failed with status $http_code"
      return 1
      ;;
  esac
}

am_ingest_verbatim() {
  local content="${1:-}"
  local metadata_json="${2:-}"
  local dedupe_key="${3:-}"
  if [ -z "$content" ]; then
    return 1
  fi
  if [ -z "$metadata_json" ]; then
    metadata_json='{}'
  fi

  if [ -n "$dedupe_key" ] && am_dedupe_seen "$dedupe_key"; then
    am_debug "dedupe marker exists: $dedupe_key"
    return 0
  fi

  local source_url
  source_url=$(am_lifecycle_source_url "$dedupe_key")
  local scope_json
  scope_json=$(am_scope_json) || return 1
  local metadata_with_scope
  metadata_with_scope=$(jq -c \
    --arg dedupe_key "$dedupe_key" \
    --argjson scope "$scope_json" \
    '(if type == "object" then . else {} end) as $metadata
     | $metadata
     + (if $dedupe_key != "" and (($metadata // {}) | has("dedupe_key") | not) then {dedupe_key: $dedupe_key} else {} end)
     + {scope: $scope}' <<EOF
$metadata_json
EOF
  ) || return 1
  local body
  body=$(am_quick_ingest_body "$content" "$source_url" "$metadata_with_scope") || return 1
  am_post_quick_ingest "$body" || return 1
  if [ -n "$dedupe_key" ]; then
    am_mark_dedupe "$dedupe_key" || return 1
  fi
  return 0
}
