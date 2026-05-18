# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities confidentially. **Do not open a public
issue for security reports.**

Preferred channel: this repository's GitHub vulnerability reporting flow
(`Security` tab → `Report a vulnerability`). If that channel is unavailable to
you, email `security@atomicmemory.dev` with a clear description, reproduction
steps, and affected package and version.

We aim to acknowledge new reports within two business days and to provide a
first triage assessment within five business days. We will coordinate
disclosure with you and credit you in the published advisory unless you ask
to remain anonymous.

## Scope

In scope:

- Published packages under the `@atomicmemory/*` npm scope that live in this
  repository (`packages/*`, `adapters/*`, public `plugins/*`).
- Host plugin manifests shipped from this repository.
- Public smoke tests, example code, and docs that ship from this repository.
- GitHub Actions workflows defined in `.github/workflows/`.

Out of scope:

- The hosted AtomicMemory service infrastructure. Hosted-service reports
  should go to `security@atomicmemory.dev` and will be triaged separately.
- Out-of-repository services and operational tooling.
- Third-party host applications (Claude Code, Cursor, Codex, OpenClaw, Hermes,
  etc.). Please file those with the host vendor and copy us if the issue
  involves an AtomicMemory plugin manifest.
- Dependencies maintained by third parties (please report upstream, then
  notify us so we can pin or patch).

## Supported versions

Each published package follows independent semver. Security fixes are released
for the latest minor of every currently-supported major. Older majors are
supported on a best-effort basis until announced end-of-life in the package
changelog.

## Coordinated disclosure

We will work with you on a disclosure timeline. The default is up to 90 days
between report and public advisory, shortened if a fix is already released and
extended only when fix complexity or coordination with hosts requires it.

## Hardening commitments

This monorepo enforces a baseline set of supply-chain controls:

- Branch protection and required CODEOWNERS review on the default branch.
- Pinned, least-privilege GitHub Actions; third-party actions pinned to commit
  SHAs or approved major versions.
- Dependency review and license review gates on pull requests.
- Secret scanning push protection where available.
- npm provenance / OIDC for packages that support it; otherwise
  `npm pack --dry-run --json` plus package-owner approval before publish.

These controls live in CI configuration and are not bypassed for convenience.
