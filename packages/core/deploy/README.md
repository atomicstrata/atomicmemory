# Deployment Configs

Platform-specific deployment configurations. Copy the relevant config to your project root or use as reference.

## Available platforms

| Platform | Directory | Notes |
|----------|-----------|-------|
| [Railway](https://railway.app) | `railway/` | Copy `railway.toml` to repo root before deploying |

## Generic deployment

The root `Dockerfile` and `docker-compose.yml` work with any Docker-compatible platform. No platform-specific config needed.

```bash
docker compose up --build
```

## Adding a new platform

Create a directory under `deploy/` with the platform name and include the necessary config files. Add a brief README or comments explaining how to use them.
