import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

const envPath = ['.env.test', '.env']
  .map((file) => resolve(process.cwd(), file))
  .find((file) => existsSync(file));

if (envPath) {
  loadDotenv({ path: envPath, override: false });
}

process.env.OPENAI_API_KEY ??= 'test-openai-key';
process.env.CORE_API_KEY ??= 'test-core-api-key';
process.env.STORAGE_KEY_HMAC_SECRET ??= '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
process.env.DATABASE_URL ??= 'postgresql://atomicmem:atomicmem@localhost:5433/atomicmem_test';
process.env.EMBEDDING_DIMENSIONS ??= '1536';
process.env.RAW_STORAGE_DEPLOYMENT_ENV ??= 'local';
// Mirror .env.test.example for route seam tests when no local env file exists;
// production config still defaults this flag to false in src/config.ts.
process.env.CORE_RUNTIME_CONFIG_MUTATION_ENABLED ??= 'true';
