#!/usr/bin/env bash
# Fresh-install smoke test for the published `am` CLI.
#
# Installs a published channel the way someone with a brand-new laptop would,
# into a throwaway $HOME, and proves the result is a working CLI:
#
#   1. Build a sandbox $HOME and an empty install dir
#   2. Fetch install.sh + version.json from the channel under test
#   3. Run the installer into that dir
#   4. Assert the installed binary reports version.json's version
#   5. Assert it identifies itself and runs a real offline subcommand
#   6. Assert PATH activation puts *this* binary first on PATH
#
# Every probe addresses the binary by absolute path, so an `am` the operator
# already has installed cannot answer for the one under test. The activation
# check is the only one that consults PATH, and a competing `am` makes that
# check stronger rather than weaker: it has to lose to the env file.
#
# Why this exists when scripts/__tests__/install-cli*.test.sh already pass:
# those are fixture tests. They drive the installer with a fake `gh` and a fake
# `am` shell script, so they prove the installer's *logic* and nothing about
# the artifact. They stay green if cli-internal-latest is deleted, if its
# tarballs and its version.json disagree, or if the real binary cannot start on
# a machine without a Rust toolchain. The release workflow's own "Native smoke"
# is closer but runs on the build runner, in the build job, minutes after
# cargo built it — the least clean machine available, and it untars directly
# without touching either installer.
#
# Two channels, because they fail differently and only one of them is what a
# user runs (ATO-1863).
#
#   internal  cli-internal-latest, via `gh release download`. Needs repo auth,
#             so anyone on the team can run it, and it says nothing about the
#             public mirror.
#   public    https://get.atomicstrata.ai, via curl — the exact command in the
#             README. Needs no auth at all, and is the one whose breakage a
#             customer finds before we do. It also reaches things the internal
#             channel structurally cannot: that the mirror serves a working
#             install.sh, and that its version.json agrees with the tarballs
#             sitting beside it.
#
# Everything after acquisition is identical, which is why this is one script
# with a switch rather than two scripts that drift.
#
# Usage:
#   ./scripts/cli-install-smoke.sh                                      # internal
#   AM_SMOKE_CHANNEL=public ./scripts/cli-install-smoke.sh              # public mirror
#   AM_INTERNAL_TAG=cli-internal-<sha> ./scripts/cli-install-smoke.sh   # pin a build
#   AM_INTERNAL_TAG=cli-canary-latest ./scripts/cli-install-smoke.sh    # floating canary
#   AM_SMOKE_MODE=provenance AM_SMOKE_CHANNEL=public ./scripts/...      # verify signatures
#   AM_SMOKE_KEEP=1 ./scripts/cli-install-smoke.sh                      # keep the sandbox
#
# AM_VERIFY_ATTESTATION is NOT an input here. `install` mode forces it to 0 for
# the installer (a downloaded script verifying its own provenance is theatre);
# signatures are checked by `provenance` mode, which calls `gh attestation
# verify` on the tarball directly.
#
# Requires: curl, tar, sha256sum or shasum. `gh` only for the internal channel
# and for `provenance` mode.

set -euo pipefail

AM_SMOKE_CHANNEL="${AM_SMOKE_CHANNEL:-internal}"

# What this invocation is allowed to do, and therefore what credential it may
# hold. The two must not run in one process (ATO-1863 review).
#
#   install     the customer path. Executes install.sh, which we downloaded
#               from a mirror and do not control. Must never hold a GitHub
#               token: that script runs before anything has authenticated it,
#               so a compromised mirror could exfiltrate the credential and
#               any later checksum or attestation check would be too late to
#               matter. It is the one step whose whole point is that a user
#               needs no repo auth.
#
#   provenance  verifies the published tarball with `gh attestation verify`,
#               from this checked-in script. Holds the token, executes nothing
#               it downloaded.
#
# Splitting them is what makes the credential unreachable rather than merely
# unused: `env -u` would still leave the token readable through the parent's
# /proc entry on Linux, so the boundary has to be the job, not the child.
AM_SMOKE_MODE="${AM_SMOKE_MODE:-install}"
AM_PUBLIC_BASE_URL="${AM_PUBLIC_BASE_URL:-https://get.atomicstrata.ai}"
# In a function, not at top level: scripts/__tests__/cli-install-smoke.test.sh
# sources this file, so a top-level `exit 2` here killed the test process. Any
# engineer or CI job with AM_SMOKE_MODE or AM_PUBLIC_BASE_URL exported turned
# `npm run test:cli-install-smoke` into a one-line refusal with 0 of its tests
# run — a gate silently reduced to nothing by an unrelated environment variable.
validate_config() {
  case "$AM_SMOKE_MODE" in
    install|provenance) ;;
    *)
      echo "AM_SMOKE_MODE must be 'install' or 'provenance', got '${AM_SMOKE_MODE}'" >&2
      return 2
      ;;
  esac

  # Enumerated at the same chokepoint as the mode. Without this, `publik`,
  # `PUBLIC` and the empty string were all classified as "a public install" by
  # needs_gh — dropping the gh requirement and skipping the AM_BASE_URL bridge,
  # then dying much later with an unrelated message. download_release_assets
  # has its own arm for this, but that is the point of consequence, not the
  # point of entry.
  case "$AM_SMOKE_CHANNEL" in
    internal|public) ;;
    *)
      echo "AM_SMOKE_CHANNEL must be 'internal' or 'public', got '${AM_SMOKE_CHANNEL}'" >&2
      return 2
      ;;
  esac

  # provenance_main downloads release metadata for AM_SMOKE_CHANNEL but always
  # attests ${AM_PUBLIC_BASE_URL}/cli/v<version>/<tarball>. With the default
  # channel that means pulling internal metadata over gh and then verifying the
  # PUBLIC mirror's tarball, reporting a pass for an artifact it never named —
  # and internal builds carry no attestations at all (release-cli.yml is the
  # only workflow with `attestations: write`).
  if [[ "$AM_SMOKE_MODE" == "provenance" && "$AM_SMOKE_CHANNEL" != "public" ]]; then
    echo "AM_SMOKE_MODE=provenance requires AM_SMOKE_CHANNEL=public;" \
      "got '${AM_SMOKE_CHANNEL}'. Only the public mirror publishes attestations." >&2
    return 2
  fi

  # Normalised before it is compared or concatenated. The allowlist accepted the
  # trailing-slash form, and every consumer builds "${BASE}/path" — so that form
  # produced "//install.sh", which the mirror 404s. Verified live: /install.sh
  # is 200, //install.sh is 404. Accepting a value that cannot work is worse
  # than rejecting it, because the failure looks like a mirror outage.
  AM_PUBLIC_BASE_URL="${AM_PUBLIC_BASE_URL%/}"

  # Enumerated, because this script downloads install.sh from that origin and
  # pipes it to `sh`. A free-text override is remote code execution on the
  # runner for anyone who can dispatch the workflow, and "only maintainers can
  # dispatch" is a policy that lives somewhere else and can change without this
  # file noticing. Exact hosts, not prefixes: `https://get.atomicstrata.ai*`
  # also matches `https://get.atomicstrata.ai.evil.com`.
  #
  # There is exactly one public mirror today. Add a second line here when there
  # is a second mirror — that is the intended way to extend this, not removing
  # it.
  case "${AM_PUBLIC_BASE_URL}" in
    https://get.atomicstrata.ai) ;;
    *)
      echo "Refusing to install from ${AM_PUBLIC_BASE_URL}: not an allowed mirror." >&2
      echo "This script pipes the downloaded install.sh to sh; the origin is pinned." >&2
      return 2
      ;;
  esac
}
AM_INTERNAL_REPO="${AM_INTERNAL_REPO:-atomicstrata/atomicmemory-internal}"
AM_INTERNAL_TAG="${AM_INTERNAL_TAG:-cli-internal-latest}"

# Who must have signed the release, and from which workflow. Pinned here rather
# than read from the release: an attestation check that trusts the artifact to
# say who signed it verifies nothing.
AM_ATTESTATION_REPO="atomicstrata/atomicmemory"
AM_ATTESTATION_WORKFLOW="atomicstrata/atomicmemory/.github/workflows/release-cli.yml"
AM_SMOKE_KEEP="${AM_SMOKE_KEEP:-0}"
# The installer picks its rc file from $SHELL. Pinning it keeps the PATH
# assertions deterministic on runners, where SHELL is often unset.
SANDBOX_SHELL="/bin/bash"
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$'

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

passed=0
failed=0
total=0
WORK=""

# All three write to stderr. read_expected_version and detect_target are called
# inside `$( )`, so anything they put on stdout is captured into the variable
# instead of shown: a version mismatch or an unsupported arch used to exit 1
# having printed zero bytes anywhere the operator could see, leaving a red job
# with an empty log. Same defect class as the swallowed `call()` exit in the
# api live-smoke.
log()  { echo -e "${GREEN}[cli-smoke]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[cli-smoke]${NC} $*" >&2; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; }

# Discards the command's own output. Redirecting the assert_ok call instead
# would also discard its PASS/FAIL line, leaving a failure with no name.
quietly() { "$@" >/dev/null 2>&1; }

# Same, but keeps stderr. For commands whose diagnostics are the only thing
# distinguishing one failure from another — `gh attestation verify` reports
# whether the digest has no attestation, the signer workflow disagrees, or the
# source ref is wrong, and all three look identical without it. Mirrors
# install-cli.sh:417, which redirects stdout only.
quietly_stdout() { "$@" >/dev/null; }

# Runs the command directly rather than eval'ing a string, so values
# containing spaces or quotes cannot change what gets tested.
assert_ok() {
  local name="$1"
  shift
  total=$((total + 1))
  if "$@"; then
    log "  PASS: $name"
    passed=$((passed + 1))
  else
    fail "  FAIL: $name"
    failed=$((failed + 1))
  fi
}

cleanup() {
  if [[ -n "$WORK" && -d "$WORK" ]]; then
    if [[ "$AM_SMOKE_KEEP" == "1" ]]; then
      warn "keeping sandbox: $WORK"
    else
      rm -rf "$WORK"
    fi
  fi
}
trap cleanup EXIT INT TERM

# `gh` is required only where it is actually used: the internal channel's
# download, and attestation verification on either. Demanding it unconditionally
# would make the public lane — whose whole point is that a user needs no repo
# auth — fail for a reason no user could ever hit.
needs_gh() {
  # Provenance is the mode that exists to use it.
  [[ "$AM_SMOKE_MODE" == "provenance" ]] && return 0
  # The internal channel downloads its release through gh; that is our own
  # private artifact and the call is made by this script, not by anything it
  # fetched.
  [[ "$AM_SMOKE_CHANNEL" == "internal" ]] && return 0
  # A public install never needs it, and must not have it — see AM_SMOKE_MODE.
  # AM_SMOKE_MODE is validated to install|provenance above, so this is total:
  # every remaining case is a public install.
  return 1
}

# The workflow runs one job per published target and names each job after it,
# but the job derives its target from `uname`, not from the matrix. Nothing tied
# the two together: GitHub has re-pointed runner labels before (macos-latest
# flipped Intel to arm64), so the leg named x86_64-apple-darwin could quietly
# install and attest the aarch64 tarball, report green, and leave the x86_64
# artifact never exercised again — invisibly, because the job name still said
# otherwise. Same silent-green class as the missing /cli/v<version> segment.
#
# No-op when AM_SMOKE_TARGET is unset, so a local run needs no ceremony.
assert_target_matches_matrix() {
  [[ -n "${AM_SMOKE_TARGET:-}" ]] || return 0
  local detected
  detected="$(detect_target)"
  assert_ok "runner matches the matrix target (${AM_SMOKE_TARGET})" \
    test "$detected" = "$AM_SMOKE_TARGET"
}

# Sets INSTALL_CMD to the argv that runs the downloaded installer.
#
# Public only: the installer arrives from a mirror and is not authenticated
# when it runs, so a locally-run smoke on a developer machine with `gh` logged
# in must not hand it a credential.
#
# The internal channel is the opposite case and must NOT be stripped. Its
# install.sh *is* our own scripts/install-cli-internal.sh
# (internal-cli-release.yml: `cp scripts/install-cli-internal.sh
# dist/install.sh`) and it reaches the private repo with `gh release download`.
# HOME is already the sandbox, so ~/.config/gh is invisible; stripping both vars
# on top of that left gh with no credential at all and the installer died with
# "are you authenticated?". Applying the strip to both channels broke the
# internal nightly on every target.
#
# Both branches are non-empty on purpose: `"${arr[@]}"` on an empty array is an
# unbound-variable error under `set -u` in bash 3.2, which the macOS runners
# ship.
set_install_cmd() {
  if [[ "$AM_SMOKE_CHANNEL" == "public" ]]; then
    INSTALL_CMD=(env -u GH_TOKEN -u GITHUB_TOKEN sh "$1")
  else
    INSTALL_CMD=(sh "$1")
  fi
}

require_commands() {
  local cmd
  local required=(curl tar python3)
  needs_gh && required+=(gh)
  for cmd in "${required[@]}"; do
    command -v "$cmd" >/dev/null 2>&1 || { fail "required command not found: $cmd"; exit 1; }
  done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || { fail "need sha256sum or shasum on PATH"; exit 1; }
}

# The installer runs under a sandbox $HOME, which would hide ~/.config/gh and
# break `gh release download`. Hand it an explicit token instead of relocating
# the operator's gh config into the sandbox.
resolve_gh_token() {
  if [[ -n "${GH_TOKEN:-}" ]]; then return 0; fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    GH_TOKEN="$GITHUB_TOKEN"
    export GH_TOKEN
    return 0
  fi
  GH_TOKEN="$(gh auth token 2>/dev/null || true)"
  [[ -n "$GH_TOKEN" ]] || { fail "gh is not authenticated; run: gh auth login"; exit 1; }
  export GH_TOKEN
}

# install-cli.sh rejects install dirs outside [A-Za-z0-9._/-]; catch a hostile
# TMPDIR here so the failure names the cause instead of surfacing as a
# confusing installer error.
make_sandbox() {
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/am-cli-smoke.XXXXXX")" || { fail "mktemp failed"; exit 1; }
  case "$WORK" in
    /*) ;;
    *) fail "sandbox is not an absolute path: $WORK"; exit 1 ;;
  esac
  case "$WORK" in
    *[!A-Za-z0-9._/-]*)
      fail "sandbox path has characters the installer rejects (set TMPDIR to a plain path): $WORK"
      exit 1
      ;;
  esac
  mkdir -p "$WORK/home" "$WORK/bin" "$WORK/release"
}

# Fetch over https with the same flags the README's one-liner uses, so a TLS or
# redirect problem that would break a real install breaks this too. `-f` is what
# turns a 404 page into a non-zero exit instead of a file full of HTML that the
# next step would cheerfully parse.
fetch_public_asset() {
  local name="$1"
  curl --proto '=https' --tlsv1.2 -fsSL --max-time 60 \
    "${AM_PUBLIC_BASE_URL}/${name}" -o "$WORK/release/${name}" \
    || { fail "could not fetch ${name} from ${AM_PUBLIC_BASE_URL}"; exit 1; }
}

download_release_assets() {
  case "$AM_SMOKE_CHANNEL" in
    internal)
      log "Downloading ${AM_INTERNAL_TAG} metadata from ${AM_INTERNAL_REPO}"
      gh release download "$AM_INTERNAL_TAG" \
        --repo "$AM_INTERNAL_REPO" \
        --dir "$WORK/release" \
        --pattern install.sh \
        --pattern version.json \
        || { fail "gh release download failed for ${AM_INTERNAL_TAG}"; exit 1; }
      ;;
    public)
      log "Fetching install.sh and version.json from ${AM_PUBLIC_BASE_URL}"
      fetch_public_asset install.sh
      fetch_public_asset version.json
      ;;
    *)
      fail "AM_SMOKE_CHANNEL must be 'internal' or 'public', got '${AM_SMOKE_CHANNEL}'"
      exit 1
      ;;
  esac
  [[ -f "$WORK/release/install.sh" ]]   || { fail "install.sh missing from the ${AM_SMOKE_CHANNEL} channel"; exit 1; }
  [[ -f "$WORK/release/version.json" ]] || { fail "version.json missing from the ${AM_SMOKE_CHANNEL} channel"; exit 1; }
}

# Read the release's own version and prove it is a real version before using it
# as an expectation. Without this an empty version.json would make the compare
# "" = "" and the whole smoke would pass while asserting nothing.
read_expected_version() {
  local version_json="$1"
  local version
  version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$version_json" | head -n1)"
  if [[ ! "$version" =~ $SEMVER_RE ]]; then
    fail "version.json does not carry an X.Y.Z version (got: '${version}')"
    exit 1
  fi

  # The install and provenance lanes are separate jobs, each fetching from the
  # mirror on its own runner. Without this they can silently disagree: a release
  # landing between them means one installs X while the other attests X+1, and
  # both report green. The workflow resolves the version once and hands the same
  # value to both, so a mismatch here means the artifact under test is not the
  # artifact that was verified — which has to be a failure, not a shrug.
  #
  # It does not make the two downloads identical. A mirror serving different
  # bytes for the same version to different runners would still pass both; that
  # would need a shared artifact rather than a shared version, and is out of
  # scope for a nightly against our own CDN.
  if [[ -n "${AM_SMOKE_EXPECT_VERSION:-}" && "$version" != "$AM_SMOKE_EXPECT_VERSION" ]]; then
    fail "release moved mid-run: expected ${AM_SMOKE_EXPECT_VERSION}, mirror now serves ${version}"
    exit 1
  fi

  printf '%s' "$version"
}

# Accept the machine-readable JSON contract (`am --version`) and the legacy
# `am X.Y.Z` banner during the one-release transition. Version comparison is
# literal string equality after parsing top-level JSON fields — dots in
# X.Y.Z must not become regex wildcards.
am_version_output_matches() {
  local reported="$1"
  local expected="$2"
  if [[ "$reported" == "am ${expected}" ]]; then
    return 0
  fi
  printf '%s' "$reported" | python3 -c '
import json, sys
expected = sys.argv[1]
try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
if not isinstance(data, dict):
    sys.exit(1)
surface = data.get("surface")
version = data.get("version")
if surface == "cli" and version == expected:
    sys.exit(0)
sys.exit(1)
' "$expected"
}

# Same rules install-cli.sh uses, so the artifact verified is the artifact a
# user on this machine would install. Copied rather than sourced: install-cli.sh
# is the file under test on the public channel, and deriving the expectation
# from the thing being tested is how a check ends up agreeing with a compromise.
detect_target() {
  local os arch os_part arch_part
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Linux)  os_part="unknown-linux-gnu" ;;
    Darwin) os_part="apple-darwin" ;;
    *) fail "unsupported OS for provenance: $os"; exit 1 ;;
  esac
  case "$arch" in
    x86_64|amd64)  arch_part="x86_64" ;;
    arm64|aarch64) arch_part="aarch64" ;;
    *) fail "unsupported arch for provenance: $arch"; exit 1 ;;
  esac
  printf '%s-%s' "$arch_part" "$os_part"
}

# Downloads the tarball and checks who signed it. Nothing here executes
# anything that came off the network — that is the property that lets this hold
# the token.
provenance_main() {
  require_commands
  resolve_gh_token
  make_sandbox
  download_release_assets

  local version target tarball url
  version="$(read_expected_version "$WORK/release/version.json")"
  assert_target_matches_matrix
  target="$(detect_target)"
  tarball="am-${version}-${target}.tar.gz"
  # Layout comes from install-cli.sh: REL_URL="${AM_BASE_URL}/cli/v${AM_VERSION}".
  # The first version of this omitted the path segment and 404'd on every
  # platform — invisible to the tests, which only ever scanned source.
  url="${AM_PUBLIC_BASE_URL}/cli/v${version}/${tarball}"

  log "Verifying provenance of ${tarball}"
  curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$WORK/release/${tarball}" \
    || { fail "could not fetch ${tarball} from ${AM_PUBLIC_BASE_URL}"; exit 1; }

  # quietly_stdout, not quietly: this is the one command the provenance job
  # exists to run, and swallowing its stderr left a failure as a bare FAIL line.
  assert_ok "gh attestation verify ${tarball}" \
    quietly_stdout gh attestation verify "$WORK/release/${tarball}" \
      --repo "${AM_ATTESTATION_REPO}" \
      --signer-workflow "${AM_ATTESTATION_WORKFLOW}" \
      --source-ref "refs/tags/cli-v${version}"

  report "provenance of am ${version}"
}

main() {
  require_commands
  needs_gh && resolve_gh_token
  make_sandbox
  download_release_assets

  local expected_version
  expected_version="$(read_expected_version "$WORK/release/version.json")"
  assert_target_matches_matrix
  log "Release ${AM_INTERNAL_TAG} declares am ${expected_version}"

  local sandbox_home="$WORK/home"
  local install_dir="$WORK/bin"
  # Kept so the activation check can start from the real PATH rather than one
  # the installer has already modified.
  local outer_path="$PATH"

  # A fresh $HOME is what makes this a *fresh install*: no ~/.atomicmemory, no
  # rc files, nothing the CLI has seen before. PATH is deliberately left alone —
  # an earlier version of this dropped every directory containing an `am`, which
  # takes gh, curl or tar with it whenever the operator installed the CLI into
  # the same prefix. That is the normal case for Homebrew and /usr/local/bin,
  # and CI never sees it because runners have no `am` to collide with.
  export HOME="$sandbox_home"
  export SHELL="$SANDBOX_SHELL"
  export AM_INTERNAL_REPO AM_INTERNAL_TAG
  # Attestation is NOT delegated to the downloaded installer any more. Letting
  # it verify itself required handing it a token, which is the thing that must
  # not happen — and a compromised installer verifying its own provenance is
  # theatre regardless. The `provenance` mode checks the same artifact from
  # this script instead. `0` also matches what a real user without `gh` gets,
  # which is the path most of them are on.
  export AM_VERIFY_ATTESTATION=0
  # install-cli.sh fetches tarballs from AM_BASE_URL, not AM_PUBLIC_BASE_URL.
  # Without this the public lane asserts --version against the *candidate*
  # version.json it just downloaded and then installs the *production* tarball —
  # the two agree on the scheduled default, so it would only ever be wrong on a
  # dispatch, which is exactly where nobody would look.
  [[ "$AM_SMOKE_CHANNEL" == "public" ]] && export AM_BASE_URL="$AM_PUBLIC_BASE_URL"
  # And pin the version. install-cli.sh re-resolves ${AM_BASE_URL}/version.json
  # when AM_VERSION is empty (install-cli.sh:646), so without this the smoke
  # asserts `am --version` against the version IT fetched while the installer
  # independently fetched again seconds later. A release publishing in that
  # window reds the job and files "the path users take is broken" when nothing
  # is — and the run never proves it installed the version resolve-release
  # pinned and public-provenance attested. mirror-cli-r2.yml:186 does the same.
  export AM_VERSION="$expected_version"

  log "Test: the sandbox starts clean"
  assert_ok "install dir starts empty" test ! -e "${install_dir}/am"
  assert_ok "sandbox HOME starts without ~/.atomicmemory" test ! -e "${sandbox_home}/.atomicmemory"

  log "Installing into ${install_dir} with HOME=${sandbox_home}"
  # Public only. Belt to the job-level braces: the public installer arrives from
  # a mirror and is not authenticated when it runs, so a locally-run smoke on a
  # developer machine with `gh` logged in must not hand it a credential.
  #
  # The internal channel is the opposite case and must NOT be stripped. Its
  # install.sh *is* our own scripts/install-cli-internal.sh
  # (internal-cli-release.yml: `cp scripts/install-cli-internal.sh
  # dist/install.sh`), and it reaches the private repo with `gh release
  # download`. HOME is already the sandbox, so ~/.config/gh is invisible too —
  # stripping both vars on top of that leaves gh with no credential at all and
  # the installer dies with "are you authenticated?". Applying the strip to
  # both channels broke the internal nightly on every target.
  set_install_cmd "$WORK/release/install.sh"
  if ! "${INSTALL_CMD[@]}" --bin-dir "$install_dir"; then
    fail "installer exited non-zero"
    exit 1
  fi

  log "Test: installed artifact"
  assert_ok "am landed in the requested bin dir" test -x "${install_dir}/am"

  local reported
  reported="$("${install_dir}/am" --version 2>/dev/null || true)"
  assert_ok "am --version reports the release's version (${expected_version})" \
    am_version_output_matches "$reported" "$expected_version"

  local help_first_line
  help_first_line="$("${install_dir}/am" --help 2>/dev/null | head -n1 || true)"
  assert_ok "am --help exits 0" quietly "${install_dir}/am" --help
  assert_ok "am --help identifies AtomicMemory" \
    grep -qi atomicmemory <<<"$help_first_line"

  # --version and --help are answered by the arg parser. This runs a real
  # command path — config load, environment resolution, output — on a $HOME
  # with no prior state, which is the first thing a new install ever does.
  log "Test: a real subcommand runs on an unconfigured HOME"
  assert_ok "am config env show succeeds with no existing config" \
    quietly "${install_dir}/am" config env show

  log "Test: PATH activation"
  local env_file="${sandbox_home}/.atomicmemory/env"
  assert_ok "installer wrote ~/.atomicmemory/env" test -f "$env_file"
  local resolved
  resolved="$(PATH="$outer_path" sh -c '. "$1" >/dev/null 2>&1; command -v am' _ "$env_file" || true)"
  assert_ok "sourcing the env file puts the installed am first on PATH" \
    test "$resolved" = "${install_dir}/am"

  report "am ${expected_version}"
}

# Shared by both modes so neither can drift into reporting a pass it did not
# earn. Exits non-zero on any failure — a smoke that returns 0 with failures
# recorded is worse than no smoke.
report() {
  local subject="$1"
  echo ""
  log "========================================="
  if [[ $failed -eq 0 ]]; then
    log "  ALL PASSED: $passed/$total checks (${subject}, $(uname -s)/$(uname -m))"
  else
    fail "  FAILED: $failed/$total checks"
  fi
  log "========================================="
  [[ $failed -eq 0 ]] || exit 1
}

# Sourcing this file (scripts/__tests__/cli-install-smoke.test.sh) must not run
# the smoke — the tests exercise the guard functions on their own.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  validate_config || exit $?
  if [[ "$AM_SMOKE_MODE" == "provenance" ]]; then
    provenance_main "$@"
  else
    main "$@"
  fi
fi
