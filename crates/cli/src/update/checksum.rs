//! SHA256SUMS lookup and digest verification for a CLI tarball.

use anyhow::{Result, bail};
use sha2::{Digest, Sha256};

/// Hex digest of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Fail closed when `bytes` do not match `expected` (case-insensitive hex).
pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<()> {
    let actual = sha256_hex(bytes);
    if actual.eq_ignore_ascii_case(expected) {
        return Ok(());
    }
    bail!("checksum mismatch (expected {expected}, got {actual})")
}

/// Find the sha256 for `filename` in a GNU `sha256sum` manifest.
pub fn expected_sha256(sums: &str, filename: &str) -> Result<String> {
    for line in sums.lines() {
        if let Some(hash) = hash_for_filename(line, filename)? {
            return Ok(hash);
        }
    }
    bail!("{filename} not listed in SHA256SUMS")
}

fn hash_for_filename(line: &str, filename: &str) -> Result<Option<String>> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let Some(hash) = parts.next() else {
        return Ok(None);
    };
    let Some(name) = parts.next() else {
        bail!("SHA256SUMS line is missing a filename");
    };
    if name != filename {
        return Ok(None);
    }
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("SHA256SUMS entry for {filename} is not a sha256 hex digest");
    }
    Ok(Some(hash.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_gnu_sha256sum_line_and_rejects_a_mismatch() {
        let sums = "abcdef  other.tar.gz\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  am-0.2.0-aarch64-apple-darwin.tar.gz\n";
        let hash = expected_sha256(sums, "am-0.2.0-aarch64-apple-darwin.tar.gz").unwrap();
        assert_eq!(hash.len(), 64);
        let bytes = b"am-bytes";
        let good = sha256_hex(bytes);
        assert!(verify_sha256(bytes, &good).is_ok());
        assert!(verify_sha256(bytes, &hash).is_err());
    }

    #[test]
    fn missing_filename_is_an_error() {
        let err = expected_sha256("abc  other.tar.gz\n", "am.tar.gz").unwrap_err();
        assert!(err.to_string().contains("not listed"));
    }
}
