//! On-disk HF snapshot probe when `am-slm models status` lies about base weights (ATO-1944).
//!
//! Accepts `snapshots/<reported revision>/` without a `refs` entry. A different
//! snapshot is not a substitute when the runtime pins a revision.

use std::fs;
use std::path::{Path, PathBuf};

use super::cache::{ModelsCacheFlags, NOMIC_BASE_IDS, QWEN_BASE_IDS, models_cache_flags};

const DEFAULT_BASE_FILES: &[&str] = &["config.json", "tokenizer.json", "model.safetensors"];

/// JSON flags plus a disk override for **base** models only. Adapter stays JSON.
pub fn models_cache_flags_with_disk(
    status: &serde_json::Value,
    hf_home: &Path,
) -> ModelsCacheFlags {
    let mut flags = models_cache_flags(status);
    if !flags.qwen {
        flags.qwen = base_snapshot_present(status, hf_home, QWEN_BASE_IDS);
    }
    if !flags.nomic {
        flags.nomic = base_snapshot_present(status, hf_home, NOMIC_BASE_IDS);
    }
    flags
}

pub fn models_cache_ready_with_disk(status: &serde_json::Value, hf_home: &Path) -> bool {
    models_cache_flags_with_disk(status, hf_home).ready()
}

fn hub_root(status: &serde_json::Value, hf_home: &Path) -> PathBuf {
    status
        .get("cache_dir")
        .and_then(|value| value.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| hf_home.join("hub"))
}

fn base_snapshot_present(status: &serde_json::Value, hf_home: &Path, ids: &[&str]) -> bool {
    let Some(entry) = find_entry(status, "models", ids) else {
        return false;
    };
    let files = required_files(entry);
    let revision = entry
        .get("revision")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty());
    let repo_id = entry
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    snapshot_has_files(&hub_root(status, hf_home), repo_id, revision, &files)
}

fn find_entry<'a>(
    status: &'a serde_json::Value,
    key: &str,
    ids: &[&str],
) -> Option<&'a serde_json::Value> {
    status.get(key)?.as_array()?.iter().find(|entry| {
        let id = entry
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        ids.contains(&id)
    })
}

fn required_files(entry: &serde_json::Value) -> Vec<String> {
    let missing = entry
        .get("missing")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter(|name| !name.is_empty() && *name != "weights")
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if missing.is_empty() {
        return DEFAULT_BASE_FILES
            .iter()
            .map(|name| (*name).to_string())
            .collect();
    }
    missing
}

fn snapshot_has_files(hub: &Path, repo_id: &str, revision: Option<&str>, files: &[String]) -> bool {
    if repo_id.is_empty() || files.is_empty() {
        return false;
    }
    let snapshots = hub.join(hf_hub_dirname(repo_id)).join("snapshots");
    match revision {
        Some(revision) => files_present(&snapshots.join(revision), files),
        None => any_snapshot_has_files(&snapshots, files),
    }
}

fn hf_hub_dirname(repo_id: &str) -> String {
    format!("models--{}", repo_id.replace('/', "--"))
}

fn any_snapshot_has_files(snapshots: &Path, files: &[String]) -> bool {
    let Ok(entries) = fs::read_dir(snapshots) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        path.is_dir() && files_present(&path, files)
    })
}

fn files_present(dir: &Path, files: &[String]) -> bool {
    files.iter().all(|name| dir.join(name).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    const QWEN: &str = "Qwen/Qwen3-0.6B";
    const NOMIC: &str = "nomic-ai/nomic-embed-text-v1.5";
    const REV: &str = "c1899de289a04d12100db370d81485cdf75e47ca";

    fn ethan_status(cache_dir: &Path) -> serde_json::Value {
        serde_json::json!({
            "cache_dir": cache_dir.display().to_string(),
            "models": [
                {
                    "id": QWEN,
                    "revision": REV,
                    "ready": false,
                    "missing": ["config.json", "tokenizer.json", "model.safetensors"]
                },
                {
                    "id": NOMIC,
                    "revision": "e9b6763023c676ca8431644204f50c2b100d9aab",
                    "ready": false,
                    "missing": ["config.json", "tokenizer.json", "model.safetensors"]
                }
            ],
            "adapters": [{ "id": "am-slm-core", "ready": true, "missing": [] }]
        })
    }

    fn write_base(hub: &Path, repo: &str, revision: &str) {
        let dir = hub
            .join(hf_hub_dirname(repo))
            .join("snapshots")
            .join(revision);
        fs::create_dir_all(&dir).unwrap();
        for name in DEFAULT_BASE_FILES {
            fs::write(dir.join(name), b"x").unwrap();
        }
    }

    #[test]
    fn empty_hub_does_not_override_json() {
        let dir = tempdir().unwrap();
        let hub = dir.path().join("hub");
        fs::create_dir_all(&hub).unwrap();
        let flags = models_cache_flags_with_disk(&ethan_status(&hub), dir.path());
        assert!(!flags.qwen && !flags.nomic);
        assert!(flags.am_slm_core);
        assert!(!flags.ready());
    }

    #[test]
    fn snapshots_at_named_revision_make_bases_ready() {
        let dir = tempdir().unwrap();
        let hub = dir.path().join("hub");
        write_base(&hub, QWEN, REV);
        write_base(&hub, NOMIC, "e9b6763023c676ca8431644204f50c2b100d9aab");
        let flags = models_cache_flags_with_disk(&ethan_status(&hub), dir.path());
        assert!(flags.qwen && flags.nomic && flags.am_slm_core);
        assert!(flags.ready());
    }

    #[test]
    fn mismatched_revision_is_not_ready() {
        let dir = tempdir().unwrap();
        let hub = dir.path().join("hub");
        write_base(&hub, QWEN, "other-pin");
        write_base(&hub, NOMIC, "other-pin");
        let flags = models_cache_flags_with_disk(&ethan_status(&hub), dir.path());
        assert!(!flags.qwen && !flags.nomic);
        assert!(!flags.ready());
    }

    #[test]
    fn unpinned_status_accepts_any_complete_snapshot() {
        let dir = tempdir().unwrap();
        let hub = dir.path().join("hub");
        write_base(&hub, QWEN, "unpinned-snap");
        write_base(&hub, NOMIC, "unpinned-snap");
        let mut status = ethan_status(&hub);
        status["models"][0]
            .as_object_mut()
            .unwrap()
            .remove("revision");
        status["models"][1]
            .as_object_mut()
            .unwrap()
            .remove("revision");
        let flags = models_cache_flags_with_disk(&status, dir.path());
        assert!(flags.ready());
    }

    #[test]
    fn adapter_false_is_not_flipped_by_base_snapshots() {
        let dir = tempdir().unwrap();
        let hub = dir.path().join("hub");
        write_base(&hub, QWEN, REV);
        write_base(&hub, NOMIC, "e9b6763023c676ca8431644204f50c2b100d9aab");
        let mut status = ethan_status(&hub);
        status["adapters"][0]["ready"] = serde_json::json!(false);
        let flags = models_cache_flags_with_disk(&status, dir.path());
        assert!(flags.qwen && flags.nomic);
        assert!(!flags.am_slm_core);
        assert!(!flags.ready());
    }
}
