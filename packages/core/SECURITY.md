# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately:

**Email:** security@atomicstrata.ai

Please do **not** open a public GitHub issue for security vulnerabilities.

## Response Timeline

- **Acknowledgment:** within 72 hours
- **Initial assessment:** within 1 week
- **Fix or mitigation:** best effort, typically within 30 days

## Scope

This policy covers the @atomicmemory/core runtime server (`src/`),
Docker configuration, and deployment templates.

It does **not** cover eval harnesses or benchmark tooling maintained
in a separate research repo.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Trusted-Proxy Identity Contract

@atomicmemory/core deliberately does **not** authenticate end users. Two
distinct credential realities apply to every authenticated `/v1/*` request:

1. **`CORE_API_KEY` authenticates the *caller process*, not the user.**
   The `requireBearer` middleware validates `Authorization: Bearer <key>`
   against the single shared `CORE_API_KEY`. Any holder of that key is an
   authenticated caller — there is no per-user token.

2. **`user_id` is *asserted by the trusted caller*.** The `user_id` carried
   in request bodies (`user_id`), query strings (`?user_id=`), or the
   `X-AtomicMemory-User-Id` header (direct-storage routes) is taken at face
   value. Core trusts the caller to have authenticated that user itself.

### Blast radius

Because the key gates the process and the caller asserts `user_id`, **any
holder of `CORE_API_KEY` can read or write any user's memories.** A leaked
key compromises *all* users, not one. There is no per-user isolation at the
core auth layer.

### Deployment guidance

- **Multi-user hosted deployments:** the control plane (Radar daemon /
  webapp proxy) must be the **only** holder of `CORE_API_KEY`. It is a
  *trusted proxy*: it authenticates the end user with its own mechanism
  (OIDC / session), then calls core on the user's behalf, asserting
  `user_id`. Untrusted client code (browser extensions, device apps) must
  never receive the key and must never call core directly — they go through
  the control-plane proxy. This mirrors the workspace trust-boundary rule:
  the client cannot hold a credential that asserts `user_id`.
- **Single-user local deployments:** this is a non-issue. The caller and the
  user are the same principal, and there is no cross-user blast radius.

### Defense-in-depth: `TRUSTED_PROXY_MODE`

To catch a daemon/proxy bug that silently cross-asserts a *different* user,
core ships an optional guard. Set `TRUSTED_PROXY_MODE=true` and the trusted
caller must restate the user it authenticated in the
`X-AtomicMemory-Asserted-User` header on every user-scoped request:

- The `assertedUserGuard` middleware compares `X-AtomicMemory-Asserted-User`
  against the request's `user_id` (body/query) or `X-AtomicMemory-User-Id`
  header.
- A **mismatch** or a **missing** asserted-user header on a request that
  carries a user identity fails closed:

  ```
  403 { "error_code": "asserted_user_mismatch" }
  ```

- A request with **no** user identity at all passes the guard untouched
  (routes that require `user_id` still 400 in their own validation).
- This is defense-in-depth; it does **not** make `user_id` independently
  trustworthy (the shared key still only authenticates the caller process).

#### Safe-by-default resolution (radar audit #14)

`TRUSTED_PROXY_MODE` is resolved from the deployment env so a hosted,
multi-tenant deployment cannot accidentally ship with the guard off. The
deployment signal is `RAW_STORAGE_DEPLOYMENT_ENV` (`production` / `staging` are
hosted; `local` is single-user):

| `RAW_STORAGE_DEPLOYMENT_ENV` | `TRUSTED_PROXY_MODE` | Effective `trustedProxyMode` |
|---|---|---|
| `production` / `staging` (hosted) | unset | **`true`** (guard on by default) |
| `production` / `staging` (hosted) | `true` | `true` |
| `production` / `staging` (hosted) | `false` | **startup fails** (refuse to disable the guard in a hosted env) |
| `local` | unset | `false` |
| `local` | `true` | `true` |
| `local` | `false` | `false` |

Non-boolean values for `TRUSTED_PROXY_MODE` are rejected at startup in all
envs. To run a hosted deployment without the guard you must change the
deployment env, not silently disable the guard.

### Deferred (not implemented)

Per-user tokens / a multi-tenant auth layer in core (so a leaked credential
compromises one user instead of all) are a larger future change and are
**out of scope** here. The current contract assumes a trusted proxy in front
of core for multi-user deployments.
