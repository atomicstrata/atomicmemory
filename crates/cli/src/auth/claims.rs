//! Decode JWT claims locally (no signature verify — display only).

use anyhow::{Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct OrgClaimV2 {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IdClaims {
    pub sub: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub iss: Option<String>,
    #[serde(default)]
    pub aud: Option<serde_json::Value>,
    #[serde(default)]
    pub exp: Option<i64>,
    #[serde(default)]
    pub org_id: Option<String>,
    /// Clerk session JWT v2 nests active org under `o`.
    #[serde(default)]
    o: Option<OrgClaimV2>,
}

impl IdClaims {
    pub fn active_org_id(&self) -> Option<&str> {
        self.org_id
            .as_deref()
            .or_else(|| self.o.as_ref().and_then(|o| o.id.as_deref()))
    }
}

pub fn token_has_active_org(id_token: &str) -> bool {
    decode_id_token(id_token)
        .ok()
        .and_then(|c| c.active_org_id().map(|_| true))
        .unwrap_or(false)
}

pub fn missing_org_login_hint() -> &'static str {
    "Session has no active organization — run `am init` to bootstrap a personal workspace, \
     or `am auth login --token <jwt>` from memory.dev with an org selected."
}

pub fn decode_id_token(id_token: &str) -> Result<IdClaims> {
    let payload = id_token
        .split('.')
        .nth(1)
        .ok_or_else(|| anyhow!("invalid id_token"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.as_bytes())
        .map_err(|_| anyhow!("invalid id_token payload"))?;
    serde_json::from_slice(&bytes).map_err(|e| anyhow!("decode id_token claims: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    fn fake_jwt(payload_json: &[u8]) -> String {
        let payload = URL_SAFE_NO_PAD.encode(payload_json);
        format!("hdr.{payload}.sig")
    }

    #[test]
    fn token_has_active_org_detects_org_id_claim() {
        assert!(token_has_active_org(&fake_jwt(
            br#"{"sub":"user_1","org_id":"org_abc"}"#
        )));
    }

    #[test]
    fn token_has_active_org_detects_clerk_o_claim() {
        assert!(token_has_active_org(&fake_jwt(
            br#"{"sub":"user_1","o":{"id":"org_abc"}}"#
        )));
    }

    #[test]
    fn token_has_active_org_false_without_org() {
        assert!(!token_has_active_org(&fake_jwt(br#"{"sub":"user_1"}"#)));
    }
}
