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

/// Redact bearer tokens, API keys, JWTs, secret assignments, and email addresses.
pub fn redact_secrets(input: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(input) {
        Ok(mut value) => {
            redact_fields(&mut value);
            redact_text(&value.to_string())
        }
        Err(_) if input.trim_start().starts_with(['{', '[']) => {
            "malformed or truncated JSON error response".into()
        }
        Err(_) => redact_text(input),
    }
}

fn redact_text(input: &str) -> String {
    let mut out = input.to_string();
    // Prefixes are ASCII, so matching is case-insensitive over ASCII only and
    // every match index lands on a char boundary.
    for prefix in ["Bearer ", "amc_", "eyJ"] {
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
    redact_assignments(&mut out);
    out.split_inclusive(char::is_whitespace)
        .map(|word| {
            if word.contains('@') {
                format!("{REDACTED}{}", &word[word.trim_end().len()..])
            } else {
                word.to_string()
            }
        })
        .collect()
}

fn redact_assignments(out: &mut String) {
    for name in [
        "access_token",
        "refresh_token",
        "api_key",
        "secret",
        "password",
        "authorization",
        "cookie",
    ] {
        let mut from = 0;
        while let Some(index) = find_prefix_ignore_ascii_case(out, name, from) {
            let after_name = index + name.len();
            from = after_name;
            let tail = out[after_name..].trim_start_matches(['\"', '\'', ' ']);
            if !tail.starts_with([':', '=']) {
                continue;
            }
            let value = tail[1..].trim_start();
            let quote = value.chars().next().filter(|c| matches!(c, '\"' | '\''));
            let value = if quote.is_some() { &value[1..] } else { value };
            let start = out.len() - value.len();
            let end = value
                .find(|c: char| match quote {
                    Some(quote) => c == quote,
                    None => c.is_whitespace() || matches!(c, '\"' | '\'' | ',' | '}' | ';'),
                })
                .map_or(out.len(), |length| start + length);
            out.replace_range(start..end, REDACTED);
            from = start + REDACTED.len();
        }
    }
}

/// Bound user-visible server diagnostics and redact structured secret fields.
pub(crate) fn error_excerpt(input: &str) -> String {
    const MAX_ERROR_CHARS: usize = 1024;
    let redacted = redact_secrets(input);
    let mut excerpt: String = redacted.chars().take(MAX_ERROR_CHARS).collect();
    if redacted.chars().count() > MAX_ERROR_CHARS {
        excerpt.push_str(" … [truncated]");
    }
    excerpt
}

fn redact_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(fields) => {
            for (name, value) in fields {
                let name = name
                    .chars()
                    .filter(|ch| !matches!(ch, '_' | '-'))
                    .collect::<String>()
                    .to_ascii_lowercase();
                if [
                    "apikey",
                    "token",
                    "secret",
                    "password",
                    "authorization",
                    "cookie",
                    "email",
                ]
                .iter()
                .any(|part| name.contains(part))
                {
                    *value = serde_json::Value::String(REDACTED.into());
                } else {
                    redact_fields(value);
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(redact_fields),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_redactor_protects_structured_subprocess_diagnostics() {
        let input = r#"{"error":{"api\u004bey":["private-key",{"value":"another-key"}]},"message":"failed"}"#;
        let redacted = redact_secrets(input);
        assert!(!redacted.contains("private-key"), "{redacted}");
        assert!(!redacted.contains("another-key"), "{redacted}");
        let value: serde_json::Value = serde_json::from_str(&redacted).unwrap();
        assert_eq!(value["error"]["apiKey"], REDACTED);
        assert_eq!(value["message"], "failed");
    }

    #[test]
    fn redacts_api_key_fields_before_rendering_nested_values() {
        let input = r#"{
            "message":"quota exceeded",
            "apiKey":"camel-secret",
            "nested":[
                {"API_KEY":["array-secret",{"value":"nested-secret"}]},
                {"api-key":{"value":"object-secret"}},
                {"a_p-i_K-e_y":123456789},
                {"api\u004bey":true}
            ]
        }"#;
        let excerpt = error_excerpt(input);
        for secret in [
            "camel-secret",
            "array-secret",
            "nested-secret",
            "object-secret",
            "123456789",
        ] {
            assert!(!excerpt.contains(secret), "leaked {secret}: {excerpt}");
        }
        let value: serde_json::Value = serde_json::from_str(&excerpt).unwrap();
        assert_eq!(value["message"], "quota exceeded");
        assert_eq!(value["apiKey"], REDACTED);
        for (index, key) in ["API_KEY", "api-key", "a_p-i_K-e_y", "apiKey"]
            .into_iter()
            .enumerate()
        {
            assert_eq!(value["nested"][index][key], REDACTED);
        }
    }

    #[test]
    fn redacts_secrets_in_truncated_json_and_plain_text() {
        for input in [
            r#"{"access_token":"private-token", "incomplete":"#,
            "upstream ACCESS_TOKEN = private-token",
            "upstream password = \"private-token multi-word-secret\" rejected",
            "rejected eyJhbGciOiJIUzI1NiJ9.payload.signature for person@example.test",
        ] {
            let excerpt = error_excerpt(input);
            for secret in [
                "private-token",
                "multi-word-secret",
                "payload.signature",
                "person@example.test",
            ] {
                assert!(!excerpt.contains(secret), "leaked {secret}: {excerpt}");
            }
        }
    }

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
