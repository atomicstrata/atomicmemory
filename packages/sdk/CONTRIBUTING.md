# Contributing to AtomicMemory SDK

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Before Opening a PR

- `pnpm typecheck` passes (runs `tsc --noEmit` on both tsconfigs)
- `pnpm test` passes
- `pnpm lint` passes
- `pnpm format` applied

## Branch Conventions

- `feat/<name>` — new feature
- `fix/<name>` — bug fix
- `docs/<name>` — documentation only
- `chore/<name>` — tooling / deps

## Subpath Export Rule

The SDK exposes subpath exports (`browser`, `storage`, `embedding`, `search`, `utils`, `core`, `memory`). Each subpath must remain **browser-safe** — no Node.js-only imports allowed. Run `pnpm build` to verify all entry points compile cleanly.

## Code Style

TypeScript only. No `any`. ESLint (`pnpm lint`) and Prettier (`pnpm format`) must pass before every commit.

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
