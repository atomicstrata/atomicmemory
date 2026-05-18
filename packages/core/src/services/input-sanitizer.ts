/**
 * Input sanitization for memory content.
 *
 * Detects prompt injection patterns, suspicious content characteristics,
 * and PII indicators in memory text before storage. Each check returns
 * a structured finding so callers can decide policy (block, flag, allow).
 *
 * Phase 3 security baseline — threat-model.md P0 item.
 */

/** A single sanitization finding with severity and match details. */
export interface SanitizationFinding {
  rule: string;
  severity: 'block' | 'warn' | 'info';
  detail: string;
}

/** Aggregate result from running all sanitization checks. */
export interface SanitizationResult {
  passed: boolean;
  findings: SanitizationFinding[];
  highestSeverity: 'block' | 'warn' | 'info' | 'none';
}

/**
 * Prompt injection patterns.
 * Sourced from reference-implementations.md §8, MINJA, InjecMEM papers.
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: 'ignore-previous' },
  { pattern: /you\s+are\s+now\s+/i, label: 'role-override' },
  { pattern: /system\s*:\s*/i, label: 'system-tag' },
  { pattern: /\[INST\]/i, label: 'llama-inst-tag' },
  { pattern: /\[\/INST\]/i, label: 'llama-inst-close' },
  { pattern: /<<SYS>>/i, label: 'llama-sys-tag' },
  { pattern: /Knowledge\s*:\s*/i, label: 'knowledge-injection' },
  { pattern: /IMPORTANT\s*:\s*override/i, label: 'importance-override' },
  { pattern: /disregard\s+(all\s+)?prior/i, label: 'disregard-prior' },
  { pattern: /forget\s+everything/i, label: 'forget-everything' },
  { pattern: /new\s+instructions?\s*:/i, label: 'new-instructions' },
  { pattern: /act\s+as\s+(if\s+)?you\s+are/i, label: 'act-as' },
  { pattern: /pretend\s+(that\s+)?you('re|\s+are)/i, label: 'pretend-to-be' },
  { pattern: /do\s+not\s+mention\s+this/i, label: 'hide-instruction' },
  { pattern: /from\s+now\s+on\s*,?\s*you/i, label: 'persistent-override' },
  { pattern: /include\s+all\s+memories\s+from/i, label: 'cross-site-exfil' },
  { pattern: /merge\s+all\s+.*memories\s+across/i, label: 'cross-site-merge' },
  { pattern: /always\s+(agree|comply|say\s+(yes|there\s+are\s+no))/i, label: 'behavior-override' },
  { pattern: /never\s+(refuse|question|deny)/i, label: 'restriction-removal' },
];

const MAX_SAFE_LENGTH = 2000;
const HIGH_NON_ASCII_RATIO = 0.3;
const REPETITION_THRESHOLD = 5;

/**
 * Normalize content before pattern matching so visually obfuscated payloads
 * collapse into a canonical form.
 */
export function normalizeForDetection(content: string): string {
  return stripZeroWidthChars(content.normalize('NFKC')).replace(/\s+/g, ' ').trim();
}

/**
 * Run all sanitization checks on a piece of content.
 * Returns a SanitizationResult with all findings.
 */
export function sanitize(content: string): SanitizationResult {
  const findings: SanitizationFinding[] = [];

  const normalized = normalizeForDetection(content);
  findings.push(...checkInjectionPatterns(normalized));
  findings.push(...checkLengthAnomaly(content));
  findings.push(...checkUnicodeAnomaly(content));
  findings.push(...checkRepetitionAnomaly(content));

  const highestSeverity = resolveHighestSeverity(findings);
  const passed = highestSeverity !== 'block';

  return { passed, findings, highestSeverity };
}

/** Remove zero-width unicode characters used to obfuscate injection patterns. */
function stripZeroWidthChars(content: string): string {
  return content.replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '');
}

/** Check content against known prompt injection patterns. */
export function checkInjectionPatterns(content: string): SanitizationFinding[] {
  const findings: SanitizationFinding[] = [];
  for (const { pattern, label } of INJECTION_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      findings.push({
        rule: `injection:${label}`,
        severity: 'block',
        detail: `Matched injection pattern: "${match[0]}"`,
      });
    }
  }
  return findings;
}

/** Flag content that is unusually long for a single memory. */
export function checkLengthAnomaly(content: string): SanitizationFinding[] {
  if (content.length > MAX_SAFE_LENGTH) {
    return [{
      rule: 'anomaly:length',
      severity: 'warn',
      detail: `Content length ${content.length} exceeds ${MAX_SAFE_LENGTH} chars`,
    }];
  }
  return [];
}

/** Flag content with unusual non-ASCII character density. */
export function checkUnicodeAnomaly(content: string): SanitizationFinding[] {
  if (content.length === 0) return [];
  const nonAsciiCount = (content.match(/[^\x20-\x7E]/g) ?? []).length;
  const ratio = nonAsciiCount / content.length;
  if (ratio > HIGH_NON_ASCII_RATIO) {
    return [{
      rule: 'anomaly:unicode',
      severity: 'warn',
      detail: `Non-ASCII ratio ${(ratio * 100).toFixed(1)}% exceeds ${HIGH_NON_ASCII_RATIO * 100}%`,
    }];
  }
  return [];
}

/** Flag content with excessive repetition (potential padding attack). */
export function checkRepetitionAnomaly(content: string): SanitizationFinding[] {
  const words = content.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 10) return [];

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  const maxFreq = Math.max(...freq.values());
  const ratio = maxFreq / words.length;
  if (ratio > 0.5 && maxFreq >= REPETITION_THRESHOLD) {
    const topWord = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return [{
      rule: 'anomaly:repetition',
      severity: 'warn',
      detail: `Word "${topWord}" appears ${maxFreq}/${words.length} times (${(ratio * 100).toFixed(0)}%)`,
    }];
  }
  return [];
}

/** Determine the highest severity among findings. */
export function resolveHighestSeverity(
  findings: SanitizationFinding[],
): 'block' | 'warn' | 'info' | 'none' {
  if (findings.some((f) => f.severity === 'block')) return 'block';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  if (findings.some((f) => f.severity === 'info')) return 'info';
  return 'none';
}
