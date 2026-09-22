//! Provider environment overlay for Connected Local SLM; dataset ownership lives in instance/storage.

use super::{SLM_CHAT_MODEL, SLM_EMBED_DIMENSIONS, SLM_EMBED_MODEL, SLM_HOST_DOCKER_BASE};
use crate::instance::docker::InstanceEnv;

/// Extra `docker run` argv so Core can reach the host Metal runtime.
pub const SLM_ADD_HOST_ARGS: &[&str] = &["--add-host", "host.docker.internal:host-gateway"];

/// Apply the Connected Local SLM provider overlay onto a Core `InstanceEnv`.
///
/// Points openai-compatible LLM + embedding endpoints at the host `am-slm`
/// runtime and clears any requirement for `OPENAI_API_KEY`.
pub fn apply_slm_overlay(env: &mut InstanceEnv) {
    env.slm = true;
    env.openai_api_key.clear();
}

/// Env var names added when `InstanceEnv.slm` is true.
pub fn slm_docker_env_names() -> Vec<&'static str> {
    vec![
        "LLM_PROVIDER",
        "LLM_API_URL",
        "LLM_API_KEY",
        "LLM_MODEL",
        "EMBEDDING_PROVIDER",
        "EMBEDDING_API_URL",
        "EMBEDDING_API_KEY",
        "EMBEDDING_MODEL",
        "EMBEDDING_DIMENSIONS",
        // TODO(ATO-1936): EXTRACTION_PROMPT_VARIANT when Core image ships compact.
    ]
}

/// Child-process env map entries for the SLM overlay.
pub fn slm_child_env_entries() -> Vec<(String, String)> {
    vec![
        ("LLM_PROVIDER".into(), "openai-compatible".into()),
        ("LLM_API_URL".into(), SLM_HOST_DOCKER_BASE.into()),
        ("LLM_API_KEY".into(), "local".into()),
        ("LLM_MODEL".into(), SLM_CHAT_MODEL.into()),
        ("EMBEDDING_PROVIDER".into(), "openai-compatible".into()),
        ("EMBEDDING_API_URL".into(), SLM_HOST_DOCKER_BASE.into()),
        ("EMBEDDING_API_KEY".into(), "local".into()),
        ("EMBEDDING_MODEL".into(), SLM_EMBED_MODEL.into()),
        (
            "EMBEDDING_DIMENSIONS".into(),
            SLM_EMBED_DIMENSIONS.to_string(),
        ),
        // Do not set EXTRACTION_PROMPT_VARIANT=compact: published Core image
        // only has full EXTRACTION_PROMPT — env is a no-op and pairing with
        // AM_SLM_CORE_COMPACT_SCHEMA mismatches. TODO(ATO-1936): restore when
        // Core image catches up.
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample_env() -> InstanceEnv {
        InstanceEnv {
            openai_api_key: "sk-test".into(),
            atomicmemory_api_key: "amc_test".into(),
            atomicmemory_api_url: "https://api.dev.example.com".into(),
            cloud_jwks_url: "https://api.dev.example.com/jwks.json".into(),
            core_api_key: None,
            slm: false,
        }
    }

    #[test]
    fn overlay_clears_openai_and_sets_slm_flag() {
        let mut env = sample_env();
        apply_slm_overlay(&mut env);
        assert!(env.slm);
        assert!(env.openai_api_key.is_empty());
        assert!(slm_docker_env_names().contains(&"LLM_PROVIDER"));
        assert!(
            slm_child_env_entries()
                .iter()
                .any(|(k, v)| k == "EMBEDDING_DIMENSIONS" && v == "768")
        );
        assert!(!slm_docker_env_names().contains(&"EXTRACTION_PROMPT_VARIANT"));
        assert!(
            slm_child_env_entries()
                .iter()
                .all(|(k, _)| k != "EXTRACTION_PROMPT_VARIANT"),
            "compact prompt deferred until Core image supports EXTRACTION_PROMPT_VARIANT"
        );
    }

    #[test]
    fn overlay_omits_compact_extraction_prompt_until_core_image() {
        assert!(
            slm_child_env_entries()
                .iter()
                .all(|(k, _)| k != "EXTRACTION_PROMPT_VARIANT")
        );
        assert!(!slm_docker_env_names().contains(&"EXTRACTION_PROMPT_VARIANT"));
    }

    #[test]
    fn add_host_args_are_host_gateway() {
        assert_eq!(
            SLM_ADD_HOST_ARGS,
            &["--add-host", "host.docker.internal:host-gateway"]
        );
    }
}
