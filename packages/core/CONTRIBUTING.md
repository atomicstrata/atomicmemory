# Contributing to @atomicmemory/core

Thanks for your interest in contributing! This guide covers setup, workflow, and quality expectations.

## Prerequisites

- Node.js 22+
- PostgreSQL 17 with [pgvector](https://github.com/pgvector/pgvector) extension
- Docker (for smoke tests and local deployment)

## Local Setup

```bash
git clone https://github.com/atomicstrata/atomicmemory.git
cd atomicmemory/packages/core
npm install

# Configure test environment
cp .env.test.example .env.test
# Edit .env.test if your Postgres is on a different host/port

# Start Postgres with pgvector (if you don't have one running):
docker compose up postgres -d

# Run tests
npm test
```

## Pre-PR Checklist

Run these before opening a PR — they match what CI runs:

```bash
npx tsc --noEmit          # Type check
npm test                   # All tests pass
fallow --no-cache          # Code health (zero issues required)
```

## Branch and Commit Conventions

- Branch from `main`
- Use descriptive branch names: `feat/add-search-filter`, `fix/cors-config`, `docs/api-reference`
- Write clear commit messages describing what changed and why

## Code Style

Enforced by `fallow` and TypeScript strict mode:

- **Files**: < 400 lines (excluding comments)
- **Functions**: < 40 lines (excluding comments, catch/finally)
- **No `any` types** — use proper interfaces and generics
- **No silent error catching** — log or propagate every error
- **No fallback modes** — if something fails, fail closed
- **DRY** — fallow flags duplicated code

See the repository contribution guide for the full style guide.

## Adding a New Endpoint

1. Add the route handler in `src/routes/`
2. Add business logic in `src/services/` (keep routes thin)
3. Add repository methods in `src/db/` if new queries are needed
4. Add tests in the corresponding `__tests__/` directory
5. Add request/response Zod schemas in `src/schemas/*.ts` and a `registerPath` entry in `src/schemas/openapi.ts`; run `npm run generate:openapi` (CI's `check:openapi` step will fail otherwise)
6. Run the full pre-PR checklist

## Adding a New Service

1. Create the service file in `src/services/`
2. Keep it focused — one responsibility per file
3. If it needs config, add the env var to `src/config.ts` and `.env.example`
4. Add unit tests with mocked dependencies
5. Wire it into `memory-service.ts` if it's part of the ingest/search pipeline

## Review Process

- All PRs require CI to pass
- Maintainer review required before merge
- Keep PRs focused — one concern per PR

## Reporting Issues

Use the [issue templates](https://github.com/atomicstrata/atomicmemory/issues/new/choose) for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
