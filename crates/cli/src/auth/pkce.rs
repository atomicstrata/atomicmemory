//! PKCE helpers (RFC 7636).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng;
use sha2::{Digest, Sha256};

pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
}

pub fn generate_pkce_pair() -> PkcePair {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = s256_challenge(&verifier);
    PkcePair {
        verifier,
        challenge,
    }
}

pub fn generate_state() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn s256_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_deterministic() {
        let a = s256_challenge("test-verifier");
        let b = s256_challenge("test-verifier");
        assert_eq!(a, b);
        assert_ne!(a, "test-verifier");
    }

    #[test]
    fn generate_pkce_pair_differs_each_call() {
        let a = generate_pkce_pair();
        let b = generate_pkce_pair();
        assert_ne!(a.verifier, b.verifier);
    }
}
