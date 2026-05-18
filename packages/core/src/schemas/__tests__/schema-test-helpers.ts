/**
 * @file Shared assertion helpers for the `src/schemas/__tests__`
 * suites. Centralises tiny accessors that every schema-error suite
 * would otherwise redeclare, so fallow's duplicate detector stays
 * clean and the surface for "what does a failed parse look like"
 * lives in one place.
 */

/**
 * Pull the first issue message out of a `safeParse` failure.
 * Throws if the parse unexpectedly succeeded — the schema test
 * suites use this to keep negative-case assertions a single line
 * without rewriting the same accessor in every file.
 */
export function firstIssueMessage(result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}): string {
  if (result.success) throw new Error('expected schema parse to fail');
  return result.error!.issues[0]?.message ?? '';
}
