/**
 * @file Zod / OpenAPI registration bootstrap.
 *
 * Call-site importers use `z.object({...}).openapi({...})` fluently
 * throughout `src/schemas/*.ts`. That fluent `.openapi()` method is
 * added by `@asteasolutions/zod-to-openapi`'s `extendZodWithOpenApi`
 * plugin. This module calls that extension exactly once, at module
 * load, so every subsequent `import { z } from 'zod'` in the repo
 * sees the extended namespace.
 *
 * Import `./zod-setup` before any schema file that uses `.openapi()`.
 * All files in `src/schemas/*.ts` must start with this import.
 */

import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export { z };
