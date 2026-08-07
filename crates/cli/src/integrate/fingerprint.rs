//! Stable fingerprints for installed MCP server entries.

use anyhow::{Context, Result};
use hex::encode;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn fingerprint_json(entry: &Value) -> Result<String> {
    let raw = serde_json::to_string(entry).context("serialize MCP entry for fingerprint")?;
    Ok(hash_bytes(raw.as_bytes()))
}

pub fn fingerprint_toml(entry: &toml::Value) -> Result<String> {
    let raw = toml::to_string(entry).context("serialize Codex MCP entry for fingerprint")?;
    Ok(hash_bytes(raw.as_bytes()))
}

fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    encode(digest)
}
