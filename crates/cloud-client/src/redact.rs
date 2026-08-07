//! Redact secrets before logging or printing error bodies.

const REDACTED: &str = "<redacted>";

/// Find `prefix` in `haystack` at or after `from`, ignoring ASCII case.
///
/// HTTP header names and values are case-insensitive, so a server echoing an
/// `Authorization` header back in an error body may spell it `BEARER` or
/// `bearer`. Matching only the exact casing we send would leak those tokens.
fn find_prefix_ignore_ascii_case(haystack: &str, prefix: &str, from: usize) -> Option<usize> {
    let hay = haystack.as_bytes();
    let pat = prefix.as_bytes();
    if pat.is_empty() || hay.len() < pat.len() {
        return None;
    }
    (from..=hay.len() - pat.len()).find(|&idx| {
        haystack.is_char_boundary(idx) && hay[idx..idx + pat.len()].eq_ignore_ascii_case(pat)
    })
}

/// Strip bearer tokens and `amc_*` keys from a string for safe logging/display.
pub fn redact_secrets(input: &str) -> String {
    let mut out = input.to_string();
    // Prefixes are ASCII, so matching is case-insensitive over ASCII only and
    // every match index lands on a char boundary.
    for prefix in ["Bearer ", "amc_"] {
        let mut search_from = 0;
        while let Some(idx) = find_prefix_ignore_ascii_case(&out, prefix, search_from) {
            let token_start = idx + prefix.len();
            let end = out[token_start..]
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',')
                .map(|n| token_start + n)
                .unwrap_or(out.len());
            // Keep the casing the input actually used; only the secret goes.
            let matched_prefix = out[idx..token_start].to_string();
            out.replace_range(idx..end, &format!("{matched_prefix}{REDACTED}"));
            search_from = token_start + REDACTED.len();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_token() {
        let s = redact_secrets("Authorization: Bearer eyJhbGciOiJIUz");
        assert!(s.contains(REDACTED));
        assert!(!s.contains("eyJhbGciOiJIUz"));
    }

    #[test]
    fn redacts_multiple_amc_keys() {
        let s = redact_secrets("amc_one and amc_two");
        assert_eq!(s.matches(REDACTED).count(), 2);
        assert!(!s.contains("amc_one"));
    }

    #[test]
    fn redacts_bearer_regardless_of_case() {
        for header in [
            "Authorization: BEARER eyJhbGciOiJIUz",
            "Authorization: bearer eyJhbGciOiJIUz",
            "Authorization: BeArEr eyJhbGciOiJIUz",
        ] {
            let s = redact_secrets(header);
            assert!(!s.contains("eyJhbGciOiJIUz"), "leaked token in {header}");
            assert!(s.contains(REDACTED), "no redaction marker in {header}");
        }
    }

    #[test]
    fn redacts_amc_keys_regardless_of_case() {
        let s = redact_secrets("key AMC_SECRETVALUE rejected");
        assert!(!s.contains("SECRETVALUE"));
        assert!(s.contains(REDACTED));
    }

    #[test]
    fn preserves_the_casing_of_the_matched_prefix() {
        let s = redact_secrets("BEARER token123");
        assert_eq!(s, format!("BEARER {REDACTED}"));
    }

    #[test]
    fn redacts_every_occurrence_across_mixed_cases() {
        let s = redact_secrets("Bearer aaa, bearer bbb, BEARER ccc");
        assert_eq!(s.matches(REDACTED).count(), 3);
        for secret in ["aaa", "bbb", "ccc"] {
            assert!(!s.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn handles_multibyte_input_without_panicking() {
        let s = redact_secrets("日本語 Bearer トークン値 amc_キー");
        assert!(s.contains(REDACTED));
        assert!(s.starts_with("日本語 "));
    }

    #[test]
    fn tolerates_prefix_at_end_of_input() {
        // Must terminate rather than spin on a zero-length token.
        let s = redact_secrets("trailing Bearer ");
        assert!(s.contains(REDACTED));
    }

    #[test]
    fn leaves_text_without_secrets_unchanged() {
        let input = "project not found: proj_abc";
        assert_eq!(redact_secrets(input), input);
    }
}
