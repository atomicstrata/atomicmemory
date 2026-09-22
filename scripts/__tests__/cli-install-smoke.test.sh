#!/usr/bin/env bash
# Guard tests for scripts/cli-install-smoke.sh.
#
# The smoke itself needs the network and an authenticated gh, so it cannot run
# as a unit test. What can be pinned here is the part that decides whether the
# smoke is measuring anything: the version expectation and the PATH sandbox.
# Both are the kind of guard that passes vacuously when it breaks — a missing
# version.json would compare "" to "" and a leftover `am` on PATH would let a
# stale binary answer every probe.
#
# Run: bash scripts/__tests__/cli-install-smoke.test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cli-install-smoke-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

passed=0
failed=0

# `!` is a shell keyword, not a command, so it cannot be passed to assert.
fails() { ! "$@"; }

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

# shellcheck source=../cli-install-smoke.sh
source "$ROOT/scripts/cli-install-smoke.sh"

write_version_json() {
  printf '%s' "$2" >"$TMP/$1"
  printf '%s' "$TMP/$1"
}

# read_expected_version exits on bad input, so each case runs in a subshell and
# is judged on its exit status and captured output.
version_case() {
  local file="$1"
  ( read_expected_version "$file" ) 2>&1
}
version_rc() {
  ( read_expected_version "$1" ) >/dev/null 2>&1
}

echo "--- channel selection (ATO-1863) ---"

# The public channel is the one a user actually runs, and it must need no repo
# auth — that is the whole reason it is a separate lane. If `gh` crept back into
# its requirements the lane would fail for a reason no user could ever hit.
# Every input pinned, including the mode. Leaving AM_SMOKE_MODE ambient meant
# `AM_SMOKE_MODE=provenance npm run test:cli-install-smoke` failed three of
# these — the test read the environment it was run in rather than the case it
# names.
gh_case() {
  ( AM_SMOKE_MODE=install AM_SMOKE_CHANNEL="$1" AM_VERIFY_ATTESTATION="$2" needs_gh )
}

assert "internal needs gh — it downloads through the API" \
  gh_case internal auto
assert "public does not need gh by default" \
  fails gh_case public auto
# These two used to assert the opposite: that demanding attestation made the
# public lane acquire a token. That was the design ATO-1863's review rejected —
# the token was acquired so the *downloaded installer* could verify itself,
# which both hands a credential to unauthenticated code and asks the artifact
# to vouch for itself. Provenance moved to its own mode, so the public install
# path now never needs `gh` whatever attestation is set to.
assert "public still does not need gh when attestation is demanded" \
  fails gh_case public 1
assert "nor for the spelled-out form" \
  fails gh_case public required

# An unrecognised channel must stop rather than fall through to whichever branch
# happens to be first. Silently smoking the internal channel while the operator
# believes they tested the public mirror is the failure this whole ticket is
# about: a green that means nothing.
channel_rc() {
  ( AM_SMOKE_CHANNEL="$1" WORK="$TMP" download_release_assets ) >/dev/null 2>&1
}
assert "an unknown channel is refused, not silently treated as internal" \
  fails channel_rc publik

echo "--- read_expected_version ---"

good="$(write_version_json good.json '{"version":"0.2.1","channel":"internal"}')"
assert "reads the version out of a well-formed version.json" \
  test "$(version_case "$good")" = "0.2.1"

empty="$(write_version_json empty.json '')"
assert "rejects an empty version.json instead of expecting the empty string" \
  fails version_rc "$empty"

blank="$(write_version_json blank.json '{"version":"","channel":"internal"}')"
assert "rejects a blank version" fails version_rc "$blank"

nonsemver="$(write_version_json tag.json '{"version":"cli-internal-latest"}')"
assert "rejects a non X.Y.Z version" fails version_rc "$nonsemver"

missing="$(write_version_json other.json '{"channel":"internal"}')"
assert "rejects a version.json with no version key" fails version_rc "$missing"

echo "--- am_version_output_matches ---"

assert "accepts machine-readable JSON version output" \
  am_version_output_matches '{"surface":"cli","version":"0.2.1","gitSha":null,"env":"dev"}' 0.2.1
assert "accepts legacy am X.Y.Z banner during transition" \
  am_version_output_matches 'am 0.2.1' 0.2.1
assert "rejects JSON with the wrong version" \
  fails am_version_output_matches '{"surface":"cli","version":"0.2.0","gitSha":null,"env":"dev"}' 0.2.1
assert "rejects a lookalike version that would match an unescaped regex" \
  fails am_version_output_matches '{"surface":"cli","version":"0x2x1"}' 0.2.1
assert "rejects malformed version JSON" \
  fails am_version_output_matches '{"surface":"cli","version":0.2.1' 0.2.1
assert "rejects a nested version field without a top-level version" \
  fails am_version_output_matches '{"surface":"cli","nested":{"version":"0.2.1"}}' 0.2.1
assert "rejects a version value containing an embedded newline" \
  fails am_version_output_matches '{"surface":"cli","version":"0.2.1\nwrong"}' 0.2.1
assert "rejects a surface value that smuggles the version after a newline" \
  fails am_version_output_matches '{"surface":"cli\n0.2.1","version":"9.9.9"}' 0.2.1

echo "--- PATH is left alone ---"

# An earlier version built a sandbox PATH with every directory holding an `am`
# dropped, to reproduce a machine that had never installed the CLI. It also
# dropped gh, curl or tar whenever the operator had installed `am` into the same
# prefix — the normal case for Homebrew and /usr/local/bin — and the smoke then
# failed inside the downloaded installer with "need GitHub CLI (gh) on PATH".
# CI could not catch it, because runners have no `am` to collide with.
#
# The probes address the binary by absolute path, so they never needed it.
assert "the harness never assigns to PATH" \
  fails grep -qE '^[[:space:]]*(export[[:space:]]+)?PATH=' "$ROOT/scripts/cli-install-smoke.sh"

# It still has to *read* PATH for the activation check, which is the one probe
# that legitimately depends on it.
assert "it still reads PATH for the activation check" \
  grep -q 'PATH="\$outer_path"' "$ROOT/scripts/cli-install-smoke.sh"

# Every am invocation is absolute. A bare `am` would be answered by whatever the
# operator has installed, which is the thing the sandbox was there to prevent.
assert "every am probe addresses the install dir directly" \
  fails grep -qE '(assert_ok|quietly)[^\n]*[^/"]\bam\b (--|config)' "$ROOT/scripts/cli-install-smoke.sh"

echo "--- the public mirror is pinned ---"

# This script downloads install.sh from AM_PUBLIC_BASE_URL and pipes it to `sh`,
# so a free-text origin is remote code execution on the runner for anyone who
# can dispatch the workflow. Prefix matching is not enough: the first case below
# is a hostname that *starts with* the real one.
# Asserts the *guard* refused, not merely that the run failed. Checking only
# for a non-zero exit passes for the wrong reason: an un-allowlisted host also
# fails later when curl cannot fetch install.sh from it, so a prefix-matching
# guard that wrongly admits `get.atomicstrata.ai.evil.com` would still look
# green here. The message is the only signal that distinguishes them.
refuses_mirror() {
  # Captured, not piped. Under `set -o pipefail` a `script | grep -q` pipeline
  # returns the script's exit 2 even when grep matches, so the assertion would
  # fail on a guard that worked perfectly.
  local out
  out="$(AM_SMOKE_MODE=install AM_SMOKE_CHANNEL=public AM_PUBLIC_BASE_URL="$1" \
    bash "$ROOT/scripts/cli-install-smoke.sh" 2>&1 || true)"
  [[ "$out" == *"Refusing to install from $1"* ]]
}

for bad in \
  "https://get.atomicstrata.ai.evil.com" \
  "https://get.atomicstrata.ai@evil.com" \
  "http://get.atomicstrata.ai" \
  "https://evil.com"; do
  assert "refuses mirror ${bad}" refuses_mirror "$bad"
done

# The installer reads AM_BASE_URL; this script downloads its inputs from
# AM_PUBLIC_BASE_URL. Without the bridge the public lane verifies the candidate
# version.json and installs the production tarball — green, and meaningless.
assert "exports AM_BASE_URL for the public channel" \
  grep -q 'export AM_BASE_URL="\$AM_PUBLIC_BASE_URL"' "$ROOT/scripts/cli-install-smoke.sh"

echo "--- the installer never holds a GitHub token ---"

# The public installer is downloaded from a mirror and executed before anything
# has authenticated it. If it holds a private-repo token, a compromised mirror
# exfiltrates the credential and every later integrity check is too late.
needs_gh_for() {
  ( AM_SMOKE_MODE="$1" AM_SMOKE_CHANNEL="$2"
    AM_VERIFY_ATTESTATION="${3:-auto}"
    needs_gh )
}

assert "a public install does not ask for a token" \
  fails needs_gh_for install public
assert "a public install does not ask for one even with attestation demanded" \
  fails needs_gh_for install public 1
assert "the internal install still may (it downloads through gh)" \
  needs_gh_for install internal
assert "provenance mode does need one" \
  needs_gh_for provenance public

# Defence in depth for a developer running this locally with `gh` logged in:
# the job boundary is the real control, but the child should not inherit a
# credential that happens to be in the parent's environment.
#
# Asserted on the built argv, not by grepping the source. The grep this
# replaced was satisfied by any line containing the literal — a comment would
# have done — and it went stale silently the moment the invocation was made
# conditional.
install_cmd_for() {
  ( AM_SMOKE_CHANNEL="$1" set_install_cmd /release/install.sh
    printf '%s' "${INSTALL_CMD[*]}" )
}

assert "a public install runs the installer with both token vars stripped" \
  test "$(install_cmd_for public)" = \
  "env -u GH_TOKEN -u GITHUB_TOKEN sh /release/install.sh"

# The internal installer IS scripts/install-cli-internal.sh, and it reaches the
# private repo with `gh release download`. Stripping the credential there — on
# top of a sandbox HOME that already hides ~/.config/gh — left gh with nothing
# and broke the internal nightly on all four targets. This is that regression
# written down.
assert "an internal install keeps its credential" \
  test "$(install_cmd_for internal)" = "sh /release/install.sh"

# Delegating attestation to the downloaded installer is what required giving it
# a token in the first place — and an installer verifying its own provenance
# proves nothing if it is the thing that was replaced. Anchored to a real
# assignment so a mention in a comment cannot satisfy it.
assert "attestation is not delegated to the downloaded installer" \
  grep -qE '^[[:space:]]*export AM_VERIFY_ATTESTATION=0[[:space:]]*$' \
  "$ROOT/scripts/cli-install-smoke.sh"

# A verifier that lets the artifact name its own signer verifies nothing.
assert "the attestation identity is pinned in this file" \
  grep -qE '^[[:space:]]*AM_ATTESTATION_REPO="atomicstrata/atomicmemory"' \
  "$ROOT/scripts/cli-install-smoke.sh"
assert "the signer workflow is pinned too" \
  grep -qE '^[[:space:]]*AM_ATTESTATION_WORKFLOW="atomicstrata/atomicmemory/\.github/workflows/release-cli\.yml"' \
  "$ROOT/scripts/cli-install-smoke.sh"

# Judged on the guard's own message and exit status, not on "the script failed".
# The previous form ran the whole script and accepted any non-zero exit, so
# deleting the mode guard outright still passed — the run simply died later at
# require_commands, and on a machine with `gh` authenticated it would have
# performed a real internal download first.
# Every input pinned, so an exported variable in the caller's environment
# cannot change which case is under test.
# `${2-internal}` not `${2:-internal}`: the colon form substitutes for an empty
# value too, so the "empty channel" case silently became the "internal" case and
# the assertion tested nothing.
validate_rc() {
  ( AM_SMOKE_MODE="$1" AM_SMOKE_CHANNEL="${2-internal}"
    AM_PUBLIC_BASE_URL="${3-https://get.atomicstrata.ai}"
    validate_config ) >/dev/null 2>&1
}
validate_msg() {
  ( AM_SMOKE_MODE="$1" AM_SMOKE_CHANNEL="${2-internal}"
    AM_PUBLIC_BASE_URL="${3-https://get.atomicstrata.ai}"
    validate_config ) 2>&1
}
# validate_config normalises in place, so the normalised value is read back from
# the same subshell. Do NOT re-source the script to test this: under
# `bash -c 'source "$0"' script.sh`, BASH_SOURCE[0] equals $0, so the main block
# runs and the "unit test" performs a real download.
normalised_base() {
  ( AM_SMOKE_MODE=install AM_SMOKE_CHANNEL=internal AM_PUBLIC_BASE_URL="$1"
    validate_config >/dev/null 2>&1
    printf '%s' "$AM_PUBLIC_BASE_URL" )
}

assert "a known mode is accepted" validate_rc install
assert "provenance is a known mode" validate_rc provenance public
assert "an unknown mode is refused" fails validate_rc bogus
assert "and it says which value it rejected" \
  grep -q "got 'bogus'" <<<"$(validate_msg bogus)"

# needs_gh treated `publik`, `PUBLIC` and "" as "a public install", dropping the
# gh requirement and the AM_BASE_URL bridge, then failing much later for an
# unrelated reason. Enumerated at entry now, like the mode.
assert "an unknown channel is refused at the validator" \
  fails validate_rc install publik
assert "channel matching is exact, not case-insensitive" \
  fails validate_rc install PUBLIC
# An empty value reaching validate_config is refused. (Set in the environment it
# never gets this far — line 62 defaults it to internal before anything reads
# it — but the enumeration must not depend on that happening first.)
assert "an empty channel is refused" fails validate_rc install ""

# provenance always attests the PUBLIC mirror's tarball, so pairing it with the
# internal channel downloaded internal metadata and then reported a pass for an
# artifact it never named. Internal builds carry no attestations at all.
assert "provenance against the internal channel is refused" \
  fails validate_rc provenance internal

assert "an unknown mirror is refused by the same validator" \
  fails validate_rc install internal https://evil.example
assert "a trailing slash is normalised, not rejected" \
  test "$(normalised_base https://get.atomicstrata.ai/)" = "https://get.atomicstrata.ai"
assert "the bare form is left alone" \
  test "$(normalised_base https://get.atomicstrata.ai)" = "https://get.atomicstrata.ai"

echo "--- the two lanes must agree on the release ---"

# install and provenance run as separate jobs on separate runners, each
# fetching from the mirror. A release landing between them would have one
# installing X while the other attests X+1, both green. The workflow resolves
# the version once; this is the check that makes a disagreement fail.
version_agreement() {
  local tmp; tmp="$(mktemp -d)"
  printf '{"version":"%s"}' "$1" > "$tmp/version.json"
  ( AM_SMOKE_EXPECT_VERSION="$2" read_expected_version "$tmp/version.json" ) >/dev/null 2>&1
  local rc=$?
  rm -rf "$tmp"
  return $rc
}

assert "accepts the version the workflow resolved" \
  version_agreement 1.2.3 1.2.3
assert "accepts any version when nothing was pinned" \
  version_agreement 1.2.3 ""
assert "refuses a release that moved mid-run" \
  fails version_agreement 1.2.4 1.2.3

# The first provenance implementation built the tarball URL without the
# `/cli/v<version>` segment and 404'd on every platform. Every test passed,
# because they all scanned source and none fetched anything. This pins the
# layout install-cli.sh actually publishes to.
assert "the provenance URL keeps the cli/v<version> path segment" \
  grep -q 'url="\${AM_PUBLIC_BASE_URL}/cli/v\${version}/\${tarball}"' \
  "$ROOT/scripts/cli-install-smoke.sh"

echo "--- the reporter grades every lane it depends on ---"

# ATO-1863 first shipped a reporter that listed `public-provenance` in `needs`
# and graded only `public-install-smoke`: a signature failure would have closed
# the issue and passed the night in silence, on the half of the lane that is the
# reason it exists. Enumerated rather than grepped for the three job names, so a
# lane added later cannot be left ungraded the same way.
reporter_check() {
  python3 "$ROOT/scripts/__tests__/reporter-grades-every-lane.py" "$@"
}
# Same check with the diagnostics muted, for the case that is meant to fail —
# so its stderr does not read as a suite failure in the CI log.
reporter_check_quiet() {
  reporter_check "$@" 2>/dev/null
}

assert "every job in a reporter's needs is graded, in both lanes" \
  reporter_check "$ROOT/.github/workflows/cli-public-install-smoke.yml" \
  "$ROOT/.github/workflows/cli-install-smoke.yml"

# The check above passes on a file it fails to parse, so prove it can still say
# no. Reintroduces the original defect on a copy.
ungraded="$TMP/ungraded-reporter.yml"
sed "/PROVENANCE_RESULT: /d" \
  "$ROOT/.github/workflows/cli-public-install-smoke.yml" >"$ungraded"
assert "an ungraded lane is reported, not passed over" \
  fails reporter_check_quiet "$ungraded"

# Presence of the variable is not the property — being *required* is. The first
# version of the checker only looked for `"$VAR" = "success"` somewhere in the
# block, so flipping the reporter's `&&` to `||` passed: any one green lane
# closed the issue, and a release with no valid attestation went unreported.
any_lane="$TMP/any-lane-reporter.yml"
sed 's|&& \[ "$INSTALL_RESULT"|\|\| [ "$INSTALL_RESULT"|; s|&& \[ "$PROVENANCE_RESULT"|\|\| [ "$PROVENANCE_RESULT"|' \
  "$ROOT/.github/workflows/cli-public-install-smoke.yml" >"$any_lane"
assert "lanes joined with || are rejected, not just counted" \
  fails reporter_check_quiet "$any_lane"

# The checker used to return "no problems" whenever its regex missed the job,
# so a workflow with every grading line deleted passed as long as the block was
# unrecognisable. Not finding the reporter must be loud.
no_reporter="$TMP/no-reporter.yml"
sed -n '1,120p' "$ROOT/.github/workflows/cli-public-install-smoke.yml" >"$no_reporter"
assert "a workflow with no reporter fails instead of passing vacuously" \
  fails reporter_check_quiet "$no_reporter"

echo ""
if [[ $failed -eq 0 ]]; then
  echo "ALL PASSED: $passed/$((passed + failed))"
else
  echo "FAILED: $failed/$((passed + failed))"
  exit 1
fi
