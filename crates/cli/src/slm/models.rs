//! Wrap `am-slm models pull|status` (never silent ~1.7GB downloads).

use std::io::{self, Write};
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Serialize;

mod progress;
mod status;

use super::SLM_CHAT_MODEL;
use super::cache::{apply_slm_cache_env, ensure_cache_roots, slm_hf_home};
use super::cache_probe::models_cache_flags_with_disk;
use super::paths::SlmPaths;

/// Outcome of an explicit models pull.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelsPullOutcome {
    pub ok: bool,
    pub message: String,
}

/// Confirm a large model download when `--yes` is absent.
pub fn confirm_models_pull(yes: bool, allow_prompt: bool) -> Result<bool> {
    if yes {
        return Ok(true);
    }
    if !allow_prompt {
        bail!(
            "model download is ~1.7GB and requires confirmation — re-run with `--yes` (non-interactive) or without `--quiet`/`-o json`"
        );
    }
    eprint!("Download am-slm models (~1.7GB)? [y/N] ");
    let _ = io::stderr().flush();
    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .context("read models pull confirmation")?;
    Ok(matches!(
        line.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

/// Run `am-slm models pull` (optionally scoped to an adapter).
///
/// No `--adapter` pulls the start-complete set: Qwen + Nomic bases, then
/// `am-slm-core`, then verifies disk cache readiness.
pub async fn pull_models(
    paths: &SlmPaths,
    adapter: Option<&str>,
    mut report: impl FnMut(&str),
) -> Result<ModelsPullOutcome> {
    require_slm_binary(paths)?;
    ensure_cache_roots(paths)?;
    if let Some(adapter) = adapter {
        run_models_pull(paths, Some(adapter), &mut report).await?;
        return Ok(completed_pull());
    }
    run_models_pull(paths, None, &mut report).await?;
    run_models_pull(paths, Some(SLM_CHAT_MODEL), &mut report).await?;
    let status = status_models_json(paths).await.map_err(|error| {
        anyhow::anyhow!(
            "{error:#}. Downloaded files were retained. Retry with `am slm models pull --yes`"
        )
    })?;
    verify_cache_status(paths, &status)?;
    Ok(completed_pull())
}

fn completed_pull() -> ModelsPullOutcome {
    ModelsPullOutcome {
        ok: true,
        message: "models pull completed".into(),
    }
}

fn require_slm_binary(paths: &SlmPaths) -> Result<()> {
    let binary = paths.binary();
    if binary.is_file() {
        return Ok(());
    }
    bail!(
        "am-slm binary not installed at {} — run `am slm install` first",
        binary.display()
    )
}

async fn run_models_pull(
    paths: &SlmPaths,
    adapter: Option<&str>,
    report: &mut impl FnMut(&str),
) -> Result<()> {
    let mut cmd = Command::new(paths.binary());
    cmd.args(["models", "pull", "--json"]);
    if let Some(adapter) = adapter {
        cmd.args(["--adapter", adapter]);
    }
    apply_slm_cache_env(&mut cmd, paths);
    progress::run(cmd, report).await.map_err(|error| anyhow::anyhow!(
        "{error:#}. Cached and partial downloads were retained. Check your connection and available disk space, then retry with `am slm models pull --yes{}`",
        adapter.map(|value| format!(" --adapter {value}")).unwrap_or_default()
    ))
}

/// Read model status asynchronously with bounded output and a deadline.
pub async fn status_models_json(paths: &SlmPaths) -> Result<serde_json::Value> {
    require_slm_binary(paths)?;
    ensure_cache_roots(paths)?;
    let mut command = Command::new(paths.binary());
    command.args(["models", "status", "--json"]);
    apply_slm_cache_env(&mut command, paths);
    status::capture(command).await
}

/// Fail closed when required model weights/adapters are not cached locally.
pub async fn ensure_models_cached(paths: &SlmPaths) -> Result<()> {
    verify_cache_status(paths, &status_models_json(paths).await?)
}

fn verify_cache_status(paths: &SlmPaths, status: &serde_json::Value) -> Result<()> {
    let flags = models_cache_flags_with_disk(status, &slm_hf_home(paths));
    if flags.ready() {
        return Ok(());
    }
    bail!("{}", cache_miss_message(&flags))
}

fn cache_miss_message(flags: &super::cache::ModelsCacheFlags) -> String {
    format!(
        "am-slm models are not cached locally (~1.7GB). missing: {}.\n\
         Download with `am slm models pull --yes`",
        flags.gaps().join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slm::cache::models_cache_flags;
    use std::fs;

    #[test]
    fn yes_skips_prompt() {
        assert!(confirm_models_pull(true, false).unwrap());
    }

    #[test]
    fn noninteractive_without_yes_refuses() {
        let err = confirm_models_pull(false, false).unwrap_err();
        assert!(err.to_string().contains("--yes"));
        assert!(err.to_string().contains("1.7GB"));
    }

    #[test]
    fn fixture_models_status_is_ready() {
        let body = include_str!("../../tests/fixtures/am-slm-models-status.json");
        let json: serde_json::Value = serde_json::from_str(body).unwrap();
        assert!(models_cache_flags(&json).ready());
    }

    #[test]
    fn incomplete_published_status_is_not_ready() {
        let body = include_str!("../../tests/fixtures/am-slm-models-status-incomplete.json");
        let json: serde_json::Value = serde_json::from_str(body).unwrap();
        assert!(!models_cache_flags(&json).ready());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn ensure_models_cached_refuses_empty_cache() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let incomplete = include_str!("../../tests/fixtures/am-slm-models-status-incomplete.json");
        fs::write(
            paths.binary(),
            format!("#!/bin/sh\nprintf '%s\\n' '{incomplete}'\n"),
        )
        .unwrap();
        std::fs::set_permissions(paths.binary(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = ensure_models_cached(&paths).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("models pull --yes"));
        assert!(msg.contains("missing: Qwen/Qwen3-0.6B, am-slm-core adapter"));
        assert!(!msg.contains("instance start"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn default_pull_runs_bases_then_core_adapter() {
        let (paths, log, _dir) = fake_slm_with_status(COMPLETE_STATUS);
        pull_models(&paths, None, |_| {}).await.unwrap();
        let recorded = fs::read_to_string(&log).unwrap();
        assert_eq!(
            recorded.lines().collect::<Vec<_>>(),
            [
                "models pull --json",
                "models pull --json --adapter am-slm-core"
            ]
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn default_pull_fails_when_status_stays_incomplete() {
        let (paths, log, _dir) = fake_slm_with_status(INCOMPLETE_STATUS);
        let err = pull_models(&paths, None, |_| {}).await.unwrap_err();
        assert!(err.to_string().contains("missing: Qwen/Qwen3-0.6B"));
        assert!(fs::read_to_string(&log).unwrap().contains("models pull"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn default_pull_accepts_r2_snapshots_when_status_json_lies() {
        let (paths, log, _dir) = fake_slm_with_status(&ato_1944_status_json());
        write_r2_snapshots(&slm_hf_home(&paths).join("hub"));
        pull_models(&paths, None, |_| {}).await.unwrap();
        let recorded = fs::read_to_string(&log).unwrap();
        assert!(recorded.contains("models pull"));
        assert!(recorded.contains("--adapter am-slm-core"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn adapter_pull_does_not_require_full_cache() {
        let (paths, log, _dir) = fake_slm_with_status(INCOMPLETE_STATUS);
        let outcome = pull_models(&paths, Some("am-slm-core"), |_| {})
            .await
            .unwrap();
        assert!(outcome.ok);
        assert_eq!(
            fs::read_to_string(&log).unwrap().trim(),
            "models pull --json --adapter am-slm-core"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn pull_does_not_inherit_child_output_and_requests_json() {
        let (paths, log, _dir) = fake_slm_with_status(COMPLETE_STATUS);
        pull_models(&paths, None, |_| {}).await.unwrap();
        assert!(
            fs::read_to_string(log)
                .unwrap()
                .lines()
                .all(|line| line.contains("--json"))
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn pull_rejects_unbounded_status_output() {
        let status = format!("{}{}", COMPLETE_STATUS, " ".repeat(128 * 1024));
        let (paths, _, _dir) = fake_slm_with_status(&status);
        let error = pull_models(&paths, None, |_| {}).await.unwrap_err();
        assert!(format!("{error:#}").contains("status output exceeds"));
    }

    #[cfg(unix)]
    const COMPLETE_STATUS: &str = include_str!("../../tests/fixtures/am-slm-models-status.json");
    #[cfg(unix)]
    const INCOMPLETE_STATUS: &str =
        include_str!("../../tests/fixtures/am-slm-models-status-incomplete.json");

    #[cfg(unix)]
    fn ato_1944_status_json() -> String {
        serde_json::json!({
            "models": [
                {
                    "id": "Qwen/Qwen3-0.6B",
                    "revision": "c1899de289a04d12100db370d81485cdf75e47ca",
                    "ready": false,
                    "missing": ["config.json", "tokenizer.json", "model.safetensors"]
                },
                {
                    "id": "nomic-ai/nomic-embed-text-v1.5",
                    "revision": "e9b6763023c676ca8431644204f50c2b100d9aab",
                    "ready": false,
                    "missing": ["config.json", "tokenizer.json", "model.safetensors"]
                }
            ],
            "adapters": [{ "id": "am-slm-core", "ready": true, "missing": [] }]
        })
        .to_string()
    }

    #[cfg(unix)]
    fn write_r2_snapshots(hub: &std::path::Path) {
        for (repo, rev) in [
            (
                "Qwen/Qwen3-0.6B",
                "c1899de289a04d12100db370d81485cdf75e47ca",
            ),
            (
                "nomic-ai/nomic-embed-text-v1.5",
                "e9b6763023c676ca8431644204f50c2b100d9aab",
            ),
        ] {
            let dir = hub
                .join(format!("models--{}", repo.replace('/', "--")))
                .join("snapshots")
                .join(rev);
            fs::create_dir_all(&dir).unwrap();
            for name in ["config.json", "tokenizer.json", "model.safetensors"] {
                fs::write(dir.join(name), b"x").unwrap();
            }
        }
    }

    #[cfg(unix)]
    fn fake_slm_with_status(
        status_json: &str,
    ) -> (SlmPaths, std::path::PathBuf, tempfile::TempDir) {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let log = dir.path().join("pull.log");
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = models ] && [ \"$2\" = pull ]; then\n\
               echo \"$*\" >> '{log}'\n\
               exit 0\n\
             fi\n\
             if [ \"$1\" = models ] && [ \"$2\" = status ]; then\n\
               printf '%s\\n' '{status}'\n\
               exit 0\n\
             fi\n\
             exit 1\n",
            log = log.display(),
            status = status_json.replace('\'', "'\\''"),
        );
        fs::write(paths.binary(), script).unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();
        (paths, log, dir)
    }
}
