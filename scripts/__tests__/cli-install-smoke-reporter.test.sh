#!/usr/bin/env bash
# Tests the failure reporter embedded in .github/workflows/cli-install-smoke.yml.
#
# The reporter decides, unattended, whether an issue is opened or closed. Its
# failure modes are quiet and backwards — closing a live issue, or reporting a
# failure that did not happen — and nobody reviews it until it has already
# misled someone. So it runs here against a stub gh.
#
# The step body and its literal env are read out of the workflow, so editing
# the workflow cannot leave this test passing against logic it no longer has.
#
# Run: bash scripts/__tests__/cli-install-smoke-reporter.test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/cli-install-smoke.yml"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cli-smoke-reporter.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

passed=0
failed=0
reporter_rc=0

assert() {
  local name="$1"
  shift
  if "$@"; then
    echo "  PASS: $name"
    passed=$((passed + 1))
  else
    echo "  FAIL: $name"
    failed=$((failed + 1))
  fi
}

node -e '
const {parse} = require("yaml");
const fs = require("fs");
const wf = parse(fs.readFileSync(process.argv[1], "utf8"));
const step = wf.jobs.report.steps.find((s) => typeof s.run === "string");
if (!step) throw new Error("no run step found in the report job");
fs.writeFileSync(process.argv[2], step.run);
// Values GitHub interpolates at run time are supplied per scenario; the
// literal ones (LABEL) belong to the workflow and are taken from it.
const literal = Object.entries(step.env || {})
  .filter(([, v]) => typeof v === "string" && !v.includes("${{"))
  .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
  .join("\n");
if (!literal) throw new Error("expected at least one literal env value (LABEL)");
fs.writeFileSync(process.argv[3], literal + "\n");
' "$WORKFLOW" "$TMP/reporter.sh" "$TMP/reporter-env.sh"

[ -s "$TMP/reporter.sh" ] || { echo "FAIL: extracted an empty reporter body"; exit 1; }
# shellcheck source=/dev/null
source "$TMP/reporter-env.sh"

mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'GH_EOF'
#!/usr/bin/env bash
# Stub gh: logs the command it was asked to run and answers from FAKE_* env.
printf '%s\n' "$*" >>"$GH_LOG"
case "$1 $2" in
  "label list") printf '%s\n' ${FAKE_LABELS:-} ;;
  "issue list") printf '%s' "${FAKE_OPEN_ISSUE:-}" ;;
esac
exit 0
GH_EOF
chmod +x "$TMP/bin/gh"

run_reporter() {
  local result="$1" open_issue="$2" labels="$3"
  : >"$TMP/gh.log"
  reporter_rc=0
  PATH="$TMP/bin:$PATH" \
  GH_LOG="$TMP/gh.log" \
  FAKE_OPEN_ISSUE="$open_issue" \
  FAKE_LABELS="$labels" \
  GH_TOKEN=stub GH_REPO=owner/repo LABEL="$LABEL" \
  SMOKE_RESULT="$result" \
  RUN_URL="https://example.invalid/run/1" \
    bash "$TMP/reporter.sh" >"$TMP/out.txt" 2>&1 || reporter_rc=$?
}

# Without this, every "did not do X" assertion also passes when the reporter
# crashed before doing anything — which is how this test first ran.
ran_clean() {
  [[ $reporter_rc -eq 0 ]] && return 0
  echo "    (reporter exited $reporter_rc: $(head -1 "$TMP/out.txt"))"
  return 1
}

# Anchored: an issue body mentioning "closes itself" must not read as a call to
# `gh issue close`. Assert on the command invoked, never on prose inside it.
invoked()     { grep -q "^$1" "$TMP/gh.log"; }
not_invoked() { ! grep -q "^$1" "$TMP/gh.log"; }

echo "--- green runs ---"

run_reporter success "" "$LABEL"
assert "ran cleanly (green, none open)" ran_clean
assert "green with nothing open opens nothing" not_invoked "issue create"
assert "green with nothing open closes nothing" not_invoked "issue close"

run_reporter success 42 "$LABEL"
assert "ran cleanly (green, one open)" ran_clean
assert "green closes the open failure issue" invoked "issue close 42"
assert "green never opens an issue" not_invoked "issue create"

echo "--- failing runs ---"

run_reporter failure "" "$LABEL"
assert "ran cleanly (failing, none open)" ran_clean
assert "first failure opens an issue" invoked "issue create"
assert "first failure closes nothing" not_invoked "issue close"

run_reporter failure 42 "$LABEL"
assert "ran cleanly (failing, one open)" ran_clean
assert "repeat failure comments instead of duplicating" invoked "issue comment 42"
assert "repeat failure opens no second issue" not_invoked "issue create"

# A job that never ran reports something other than "success"; anything that is
# not success has to be reported, or a smoke that failed to start reads as green.
run_reporter skipped "" "$LABEL"
assert "ran cleanly (skipped)" ran_clean
assert "a skipped smoke is reported, not read as green" invoked "issue create"

echo "--- label bootstrap ---"

run_reporter failure "" "some-other-label"
assert "ran cleanly (label absent)" ran_clean
assert "creates the label when the repo lacks it" invoked "label create"

run_reporter failure "" "$LABEL some-other-label"
assert "ran cleanly (label present)" ran_clean
assert "does not recreate an existing label" not_invoked "label create"

echo ""
if [[ $failed -eq 0 ]]; then
  echo "ALL PASSED: $passed/$((passed + failed))"
else
  echo "FAILED: $failed/$((passed + failed))"
  exit 1
fi
