/**
 * Registers the deny-compiler loader hook so that every subsequent ESM
 * `import` in the same process sees `llm-wiki-compiler` as unresolvable.
 * Used via `--import` in the missing-peer subprocess test.
 */
import { register } from "node:module";
register("./deny-compiler.loader.mjs", import.meta.url);
