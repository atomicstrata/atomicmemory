# Git hooks

Committed git hooks for the AtomicMemory monorepo. They are installed into the
clone's active hooks directory by `scripts/git-hooks/install-hooks.mjs`, which
runs as the root `prepare` script on `pnpm install`. No hook-manager dependency
is used.

## Hooks

- **`pre-push`** — blocks `git push` whose destination is the public mirror
  `atomicstrata/atomicmemory`. The public repo is a read-only release surface:
  it is updated only by the internal `public:sync` tooling (which opens a
  sanitized public PR) and realigned by the public repo's `sync-to-private.yml`
  workflow. Develop in `atomicmemory-internal` and publish through the tooling —
  never push to public directly, including via a dev clone's `upstream` remote.

  Policy lives in `scripts/guards/guard-public-push.mjs` (pure, unit-tested
  under `scripts/guards/__tests__/`). The hook is a thin shim that forwards
  git's `<remote-name> <remote-url>` arguments to that guard.

## Override

The publish tooling sets `ALLOW_PUBLIC_ATOMICMEMORY_PUSH=1` so its own,
reviewed push to the public repo is not blocked. A human can use the same
override in the rare case a direct public push is genuinely correct:

```bash
ALLOW_PUBLIC_ATOMICMEMORY_PUSH=1 git push ...
```

## Notes

- The installer is worktree-correct: it resolves the shared common hooks dir via
  `git rev-parse --git-path hooks`, so linked worktrees are covered too.
- It never overwrites a pre-existing hook it did not author (it checks for a
  marker string first).
- It only activates in clones where `pnpm install` has run. A read-only public
  mirror clone where deps are never installed should rely on a locally
  installed hook instead; see the internal ops release-process docs.
- The hook lives in the shared common hooks dir, so it also runs from a checkout
  that predates the guard (a branch cut before it landed). When the guard script
  is absent there, the hook is a no-op instead of bricking every push from that
  checkout — there is nothing to enforce, and the guard is an accidental-push
  guard, not a security boundary.

See the internal ops release-process documentation for the full
internal → public release flow.
