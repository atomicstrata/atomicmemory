//! Bounded asynchronous cache-status capture for the model download lifecycle.

use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncRead, AsyncReadExt};

const MAX_STATUS_BYTES: usize = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 8 * 1024;
const STATUS_TIMEOUT: Duration = Duration::from_secs(30);

/// Capture the small runtime model catalog without blocking the async executor.
pub(super) async fn capture(command: Command) -> Result<serde_json::Value> {
    let mut command = tokio::process::Command::from(command);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("spawn am-slm models status")?;
    let stdout = child.stdout.take().context("capture model status")?;
    let stderr = child
        .stderr
        .take()
        .context("capture model status diagnostics")?;
    let operation = async {
        let (bytes, diagnostics) = tokio::try_join!(
            read_bounded(stdout, MAX_STATUS_BYTES, "model status output"),
            read_bounded(stderr, MAX_DIAGNOSTIC_BYTES, "model status diagnostics"),
        )?;
        let status = child.wait().await.context("wait for model status")?;
        if !status.success() {
            let diagnostics: String = String::from_utf8_lossy(&diagnostics)
                .chars()
                .filter(|ch| !ch.is_control() || *ch == '\n')
                .collect();
            let diagnostics = am_cloud_client::redact::redact_secrets(&diagnostics);
            bail!(
                "am-slm models status failed (exit {status}): {}",
                diagnostics.trim()
            );
        }
        serde_json::from_slice(&bytes).context("parse am-slm models status --json")
    };
    let result = tokio::select! {
        result = operation => result,
        signal = tokio::signal::ctrl_c() => signal.context("listen for status cancellation").and_then(|()| Err(anyhow::anyhow!("model status cancelled"))),
        () = tokio::time::sleep(STATUS_TIMEOUT) => Err(anyhow::anyhow!("model status timed out after 30 seconds")),
    };
    if result.is_err() {
        child.kill().await.context("stop failed model status")?;
    }
    result
}

async fn read_bounded(
    stream: impl AsyncRead + Unpin,
    limit: usize,
    label: &str,
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stream
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .with_context(|| format!("read {label}"))?;
    if bytes.len() > limit {
        bail!("{label} exceeds {limit} bytes");
    }
    Ok(bytes)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn status_deadline_stops_a_runtime_that_never_exits() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "while :; do :; done"]);
        let error = capture(command).await.unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }
}
