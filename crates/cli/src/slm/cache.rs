//! CLI-owned model cache directories for published am-slm (HF_HOME + AM_SLM_CACHE).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};

use super::paths::SlmPaths;
use super::{SLM_CHAT_MODEL, SLM_EMBED_MODEL};

/// Hugging Face / catalog IDs emitted by published am-slm 0.1.1 `models status --json`.
pub(crate) const QWEN_BASE_IDS: &[&str] = &["Qwen/Qwen3-0.6B", "qwen3-0.6b"];
pub(crate) const NOMIC_BASE_IDS: &[&str] = &[
    "nomic-ai/nomic-embed-text-v1.5",
    "nomic-embed-text-v1.5",
    SLM_EMBED_MODEL,
];
const CORE_ADAPTER_IDS: &[&str] = &[SLM_CHAT_MODEL];

const GAP_QWEN: &str = "Qwen/Qwen3-0.6B";
const GAP_NOMIC: &str = "nomic-ai/nomic-embed-text-v1.5";
const GAP_ADAPTER: &str = "am-slm-core adapter";

const HF_HOME_DIR: &str = "hf-home";
const ADAPTER_CACHE_DIR: &str = "am-slm-cache";

/// Per-artifact disk cache flags from `am-slm models status --json`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ModelsCacheFlags {
    pub qwen: bool,
    pub nomic: bool,
    pub am_slm_core: bool,
}

impl ModelsCacheFlags {
    pub fn ready(self) -> bool {
        self.qwen && self.nomic && self.am_slm_core
    }

    pub fn gaps(self) -> Vec<&'static str> {
        let mut gaps = Vec::new();
        if !self.qwen {
            gaps.push(GAP_QWEN);
        }
        if !self.nomic {
            gaps.push(GAP_NOMIC);
        }
        if !self.am_slm_core {
            gaps.push(GAP_ADAPTER);
        }
        gaps
    }
}

/// Hugging Face weights cache root owned by the CLI (published runtime reads HF_HOME).
pub fn slm_hf_home(paths: &SlmPaths) -> PathBuf {
    paths.root().join(HF_HOME_DIR)
}

/// Merged adapter cache root (published runtime reads AM_SLM_CACHE).
pub fn slm_adapter_cache(paths: &SlmPaths) -> PathBuf {
    paths.root().join(ADAPTER_CACHE_DIR)
}

/// Directories deleted by `uninstall --purge-models`.
pub fn managed_model_cache_dirs(paths: &SlmPaths) -> [PathBuf; 2] {
    [slm_hf_home(paths), slm_adapter_cache(paths)]
}

/// Apply the cache contract understood by published am-slm 0.1.1+.
pub fn apply_slm_cache_env(cmd: &mut Command, paths: &SlmPaths) {
    cmd.env("HF_HOME", slm_hf_home(paths));
    cmd.env("AM_SLM_CACHE", slm_adapter_cache(paths));
    cmd.env_remove("AM_SLM_MODELS_DIR");
}

pub fn ensure_cache_roots(paths: &SlmPaths) -> Result<()> {
    fs::create_dir_all(slm_hf_home(paths)).context("create HF_HOME cache directory")?;
    fs::create_dir_all(slm_adapter_cache(paths)).context("create AM_SLM_CACHE directory")?;
    Ok(())
}

pub fn purge_managed_model_cache(paths: &SlmPaths) -> Result<()> {
    for dir in managed_model_cache_dirs(paths) {
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .with_context(|| format!("remove managed model cache {}", dir.display()))?;
        }
    }
    Ok(())
}

/// Parse published `am-slm models status --json` (`models`/`adapters` arrays).
///
/// Required: Qwen + Nomic base weights and the `am-slm-core` adapter, each
/// with `ready: true`. Top-level `ready` is ignored — the 0.1.1 runtime does
/// not emit it, and a lone flag must not skip the ID checks.
pub fn models_cache_flags(status: &serde_json::Value) -> ModelsCacheFlags {
    let models = status_entries(status, "models");
    let adapters = status_entries(status, "adapters");
    ModelsCacheFlags {
        qwen: entry_ready(models, QWEN_BASE_IDS),
        nomic: entry_ready(models, NOMIC_BASE_IDS),
        am_slm_core: entry_ready(adapters, CORE_ADAPTER_IDS),
    }
}

fn status_entries<'a>(status: &'a serde_json::Value, key: &str) -> &'a [serde_json::Value] {
    status
        .get(key)
        .and_then(|value| value.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn entry_ready(entries: &[serde_json::Value], ids: &[&str]) -> bool {
    entries.iter().any(|entry| {
        let id = entry
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        ids.contains(&id) && entry.get("ready").and_then(|value| value.as_bool()) == Some(true)
    })
}

/// Contract test helper: published runtime reports HF_HOME as cache_dir.
#[cfg(test)]
fn cache_dir_matches_hf_home(status: &serde_json::Value, hf_home: &Path) -> bool {
    status
        .get("cache_dir")
        .and_then(|v| v.as_str())
        .is_some_and(|dir| Path::new(dir) == hf_home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn empty_status_is_not_ready() {
        assert!(!models_cache_flags(&serde_json::json!({})).ready());
    }

    #[test]
    fn top_level_ready_flag_does_not_skip_id_checks() {
        assert!(!models_cache_flags(&serde_json::json!({"ready": true})).ready());
    }

    #[test]
    fn published_array_schema_requires_qwen_nomic_and_core() {
        let complete = include_str!("../../tests/fixtures/am-slm-models-status.json");
        let incomplete = include_str!("../../tests/fixtures/am-slm-models-status-incomplete.json");
        assert!(models_cache_flags(&serde_json::from_str(complete).unwrap()).ready());
        assert!(!models_cache_flags(&serde_json::from_str(incomplete).unwrap()).ready());
    }

    #[test]
    fn gaps_name_qwen_nomic_and_adapter_independently() {
        let incomplete = include_str!("../../tests/fixtures/am-slm-models-status-incomplete.json");
        let gaps = models_cache_flags(&serde_json::from_str(incomplete).unwrap()).gaps();
        assert_eq!(gaps, ["Qwen/Qwen3-0.6B", "am-slm-core adapter"]);
        let complete = include_str!("../../tests/fixtures/am-slm-models-status.json");
        assert!(
            models_cache_flags(&serde_json::from_str(complete).unwrap())
                .gaps()
                .is_empty()
        );
    }

    #[test]
    fn cache_dir_follows_hf_home_fixture() {
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        let hf_home = slm_hf_home(&paths);
        let status = serde_json::json!({"cache_dir": hf_home.display().to_string()});
        assert!(cache_dir_matches_hf_home(&status, &hf_home));
    }
}
