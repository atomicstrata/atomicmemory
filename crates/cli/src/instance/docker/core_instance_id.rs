//! Read the persisted runtime identity with bounded Docker output and lifetime.

use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const INSTANCE_ID_PATH: &str = "/var/lib/atomicmemory/state/core-instance-id";
const MAX_INSTANCE_ID_BYTES: usize = 2048;
const MAX_INSTANCE_ID_CHARS: usize = 512;
const ID_READ_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn read(binary: &str, container: &str) -> Result<Option<String>> {
    let mut child = Command::new(binary)
        .args(["exec", container, "cat", INSTANCE_ID_PATH])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("read managed Core runtime identity")?;
    let stdout = child
        .stdout
        .take()
        .context("capture Core runtime identity")?;
    let operation = async {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_INSTANCE_ID_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > MAX_INSTANCE_ID_BYTES {
            bail!("Core runtime identity exceeds its size limit");
        }
        let status = child.wait().await?;
        if !status.success() {
            bail!(
                "cannot read persisted Core runtime identity (docker exit {status}); restart this profile's instance and retry"
            );
        }
        let raw = String::from_utf8(bytes).context("invalid Core runtime identity encoding")?;
        let id = raw.trim();
        if id.is_empty() {
            return Ok(None);
        }
        if id.chars().count() > MAX_INSTANCE_ID_CHARS || id.chars().any(char::is_control) {
            bail!("invalid persisted Core runtime identity");
        }
        Ok(Some(id.to_string()))
    };
    let result = tokio::time::timeout(ID_READ_TIMEOUT, operation)
        .await
        .context("Core runtime identity read timed out")
        .and_then(|result| result);
    if result.is_err() {
        child
            .kill()
            .await
            .context("stop Core runtime identity read")?;
    }
    result
}
