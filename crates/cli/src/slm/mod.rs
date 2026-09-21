//! Managed `am-slm` runtime for Connected Local SLM (ATO-1936).
//!
//! Public contract: `https://get.atomicstrata.ai/am-slm/version.json` (0.1.1).
//! Apple Silicon macOS only until Linux/Intel artifacts exist.

#![allow(unused_imports)] // re-exports form the public SLM API surface
pub mod bootstrap;
pub mod cache;
pub mod cache_probe;
pub mod core_env;
pub mod health;
pub mod install;
pub mod manifest;
pub mod models;
pub mod paths;
pub mod process;
pub mod process_identity;
pub mod status;

pub use bootstrap::{BootstrapConfirm, bootstrap_managed_slm, disk_cache_ready, runtime_missing};
pub use cache::{
    apply_slm_cache_env, ensure_cache_roots, managed_model_cache_dirs, models_cache_flags,
    purge_managed_model_cache, slm_adapter_cache, slm_hf_home,
};
pub use cache_probe::{models_cache_flags_with_disk, models_cache_ready_with_disk};
pub use core_env::{
    SLM_ADD_HOST_ARGS, apply_slm_overlay, slm_child_env_entries, slm_docker_env_names,
};
pub use health::{RequiredModels, check_ready, wait_until_ready};
pub use install::{InstallOutcome, install_or_update, uninstall};
pub use manifest::{
    DEFAULT_MANIFEST_URL, ManifestArtifact, VersionManifest, current_platform_label,
    current_target, fetch_manifest, parse_manifest, select_artifact,
};
pub use models::{
    ModelsPullOutcome, confirm_models_pull, ensure_models_cached, pull_models, status_models_json,
};
pub use paths::{SlmPaths, SlmStateFile, default_slm_paths};
pub use process::{
    SLM_CORE_JSON_SCHEMA_ENV, StartOutcome, StopOutcome, pid_alive, preflight_managed_start,
    read_log_tail, slm_serve_env_entries, start_runtime, stop_runtime,
};
pub use status::{SlmStatusJson, collect_status};

/// Default OpenAI-compatible listen port for managed `am-slm serve`.
pub const DEFAULT_SLM_PORT: u16 = 8080;

/// Chat model id when the core adapter is loaded.
pub const SLM_CHAT_MODEL: &str = "am-slm-core";

/// Embedding model id Core should call (no query/document suffix).
pub const SLM_EMBED_MODEL: &str = "nomic-embed-text";

/// Nomic embedding dimensionality for Connected Local SLM.
pub const SLM_EMBED_DIMENSIONS: u32 = 768;

/// Runtime API compatibility token from the public manifest.
pub const RUNTIME_API_COMPAT: &str = "am-slm-openai-v1";

/// Base URL Core containers use to reach the host Metal runtime.
pub const SLM_HOST_DOCKER_BASE: &str = "http://host.docker.internal:8080/v1";

/// Env override for the manifest URL (tests / mirrors).
pub const ENV_MANIFEST_URL: &str = "AM_SLM_MANIFEST_URL";

/// Resolve the manifest URL (env override or public default).
pub fn manifest_url_from_env() -> String {
    std::env::var(ENV_MANIFEST_URL).unwrap_or_else(|_| DEFAULT_MANIFEST_URL.to_string())
}
