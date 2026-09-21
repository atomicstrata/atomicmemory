/**
 * Closed prompt-variant type for extraction and AUDN.
 * Parsed once at startup from EXTRACTION_PROMPT_VARIANT.
 */

export type ExtractionPromptVariant = 'full' | 'compact';

const VALID_VARIANTS: ReadonlySet<ExtractionPromptVariant> = new Set(['full', 'compact']);

/** Fail-closed parse: only exact `full` or `compact`; unset defaults to `full`. */
export function parseExtractionPromptVariant(raw: string | undefined): ExtractionPromptVariant {
  if (raw === undefined || raw === '') return 'full';
  if (VALID_VARIANTS.has(raw as ExtractionPromptVariant)) {
    return raw as ExtractionPromptVariant;
  }
  throw new Error(`EXTRACTION_PROMPT_VARIANT must be 'full' or 'compact' (got '${raw}')`);
}
