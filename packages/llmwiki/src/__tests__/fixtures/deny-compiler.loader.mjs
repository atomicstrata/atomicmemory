/**
 * Node ESM loader hook that makes `llm-wiki-compiler` unresolvable.
 * Used by the missing-peer subprocess test to simulate the optional peer
 * not being installed without actually uninstalling it.
 */
export async function resolve(specifier, context, next) {
  if (specifier === "llm-wiki-compiler") {
    const e = new Error(`Cannot find package 'llm-wiki-compiler' imported from ${context.parentURL ?? "x"}`);
    e.code = "ERR_MODULE_NOT_FOUND";
    throw e;
  }
  return next(specifier, context);
}
