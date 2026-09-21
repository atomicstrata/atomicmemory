# CLI version contract (ATO-1844)

Machine-readable version identity for the `am` CLI. The upgrade gate
([ATO-1843](https://linear.app/atomic-strata/issue/ATO-1843)) depends on this
shape; it does **not** live in this document’s scope (no throttle / force-upgrade
here).

## `am --version` / `am -V`

Prints one JSON object on stdout (exit 0), no `am ` prefix:

```json
{"surface":"cli","version":"0.2.0","gitSha":null,"env":"dev"}
```

| Field | Meaning |
| --- | --- |
| `surface` | Always `"cli"` for this binary. |
| `version` | Crate / workspace semver (`CARGO_PKG_VERSION`). Same number as git tags `cli-v*`. Do not invent a second version. |
| `gitSha` | Commit SHA stamped at CI via `AM_GIT_SHA`. JSON `null` when unset (local/`cargo build`). Never a placeholder like `"unknown"`. |
| `env` | Build channel stamped via `AM_BUILD_ENV` (`dev` default; `production` / `internal` / `canary` in release lanes). |

Shipped (CI) builds must have a non-empty `gitSha`. Local and unstamped
developer builds intentionally leave it `null`.

## Latest-version discovery

Clients (and ATO-1843) discover the newest published CLI from the install
mirror:

```text
GET https://get.atomicstrata.ai/version.json
```

Internal eng builds use the floating internal release’s `version.json` (same
object shape). Document body:

```json
{
  "surface": "cli",
  "version": "0.2.0",
  "gitSha": "abc…",
  "env": "production",
  "tag": "cli-v0.2.0"
}
```

`tag` is installer metadata; parsers for the upgrade gate may ignore it.
`version` / `gitSha` / `env` / `surface` match `--version`.

Rust helper (no enforcement): `crate::version::fetch_latest_version(base_url)` in the CLI crate.

## CI stamp

Release workflows set compile-time env when building `am`:

- `AM_GIT_SHA=<github.sha>`
- `AM_BUILD_ENV=production` (public), `internal` (main eng lane), or `canary` (dev eng lane)

Override discovery base in tests with any HTTPS origin that serves `version.json`.

## Public release bump rule

Public releases use git tags `cli-vX.Y.Z` on the public product repository. The
workspace semver in root `Cargo.toml` must match the tag exactly. The next
public release must be an **adjacent** semver increment over the highest
existing `cli-v*` tag:

| Last public | Allowed next |
| --- | --- |
| `A.B.C` | `A.B.(C+1)` (patch) |
| `A.B.C` | `A.(B+1).0` (minor) |
| `A.B.C` | `(A+1).0.0` (major) |

Jumps (`0.2.0` → `0.2.5`), downgrades, and re-tagging the same version are
rejected. Internal/canary lanes may ship multiple builds at the same workspace
semver; only the public tag is monotonic.

Enforcement: `scripts/ci/validate-cli-version-bump.sh` runs in
`release-cli.yml` (hard gate on tag push) and `ci-rust.yml` (PR early gate).
The four workspace dependency pins (`am-core-types`, `am-cloud-types`,
`am-cloud-client`, `atomicmemory`) and their `Cargo.lock` entries must stay
lockstep with `[workspace.package].version`.

To cut a bump, do not edit those fields by hand. Refresh pins and the lockfile
together:

```bash
pnpm run bump:cli-version -- 0.2.2
```
