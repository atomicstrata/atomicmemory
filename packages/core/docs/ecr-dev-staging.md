# Core Dev/Staging ECR images

Dev and Staging ECS run Core from the private enterprise ECR repository, not
from public GHCR. Images are built from `atomicmemory-internal` whenever
`@atomicmemory/core`'s version on `dev` changes.

## Pipeline

| Lane | Workflow | Registry | Trigger |
| --- | --- | --- | --- |
| Public release | `publish-core-docker.yml` | `ghcr.io/atomicstrata/atomicmemory-core` | npm publish (`repository_dispatch`) |
| Internal GHCR test | `internal-core-docker-image.yml` | `ghcr.io/atomicstrata/atomicmemory-core-internal` | `main` paths / dispatch |
| **Dev/Staging ECS** | `core-ecr-dev-staging.yml` | `…/atomicmemory-core-enterprise` | `dev` version bump / dispatch |

`core-ecr-dev-staging.yml` is named outside the `publish-*.yml` prefix on
purpose: release-policy forbids `workflow_dispatch` on that prefix, and this
lane must stay operator-dispatchable.

## Tags

Each successful build pushes (linux/amd64, Fargate):

- `${VERSION}` — from `packages/core/package.json` (e.g. `1.2.2`)
- `sha-${GITHUB_SHA:0:7}` — immutable per commit (preferred for ECS)
- `dev` — floating tip of the last successful Dev/Staging publish

OCI labels: `org.opencontainers.image.revision`, `.version`,
`.source=atomicmemory-internal`.

Example:

```text
636941960505.dkr.ecr.us-east-1.amazonaws.com/atomicmemory-core-enterprise:1.2.2
636941960505.dkr.ecr.us-east-1.amazonaws.com/atomicmemory-core-enterprise:sha-a1b2c3d
636941960505.dkr.ecr.us-east-1.amazonaws.com/atomicmemory-core-enterprise:dev
```

ECS task definitions are updated to the immutable `sha-…` URI (or `${VERSION}`
when reusing an existing version tag without a rebuild).

## After push

1. Write SSM String parameters (defaults; override with repo vars if infra differs):
   - `/am-cloud/dev/core_image`
   - `/am-cloud/staging/core_image`
2. Register a new task-definition revision with the new image URI for any
   container already pointing at `atomicmemory-core-enterprise`.
3. `update-service --force-new-deployment` on:
   - `atomicmemory-dev-cluster` / `atomicmemory-core`
   - `atomicmemory-staging-cluster` / `atomicmemory-core`

## Required GitHub Actions variables

Companion infra (OIDC role + SSM params) must exist before the first real run.
Do not put role ARNs or account secrets in this repository — configure them as
repository **variables** on `atomicstrata/atomicmemory-internal`:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AWS_CORE_ECR_PUBLISH_ROLE_ARN` | one of shared / per-env | Shared GitHub OIDC role that can push ECR, write SSM, register ECS task defs |
| `AWS_CORE_ECR_PUBLISH_ROLE_ARN_DEV` | optional | Dev-only role; falls back to the shared ARN |
| `AWS_CORE_ECR_PUBLISH_ROLE_ARN_STAGING` | optional | Staging-only role; falls back to the shared ARN |
| `AWS_REGION` | optional | Defaults to `us-east-1` |
| `AWS_CORE_IMAGE_SSM_PARAM_DEV` | optional | Defaults to `/am-cloud/dev/core_image` |
| `AWS_CORE_IMAGE_SSM_PARAM_STAGING` | optional | Defaults to `/am-cloud/staging/core_image` |

## Operator dispatch

Actions → **Core ECR Dev/Staging** → Run workflow:

- `ref` — branch/tag/SHA to build (empty = triggering SHA)
- `deploy_dev` / `deploy_staging` — default true; set false for image-only
- `force` — rebuild even when the `${VERSION}` tag already exists in ECR

Dry-run once OIDC is wired: dispatch with `deploy_dev=false` and
`deploy_staging=false` to push tags without rolling ECS.
