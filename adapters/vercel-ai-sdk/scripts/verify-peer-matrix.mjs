/** Run actual packed consumers against the supported AI SDK and Zod peer endpoints. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const verifier = fileURLToPath(new URL('./verify-packed.mjs', import.meta.url));
for (const ai of ['6.0.0', '6.0.300']) {
  for (const zod of ['3.25.76', '4.1.8', '4.6.5']) {
    execFileSync(process.execPath, [verifier], {
      env: { ...process.env, AI_SDK_VERSION: ai, ZOD_VERSION: zod }, stdio: 'inherit',
    });
  }
}
