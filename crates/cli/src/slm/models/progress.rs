//! Bounded runtime download event reader and human progress summaries.

use std::collections::HashMap;
use std::future::Future;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};

const MAX_EVENT_BYTES: usize = 16 * 1024;
const MAX_FILES: usize = 256;
const REPORT_BYTES: u64 = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Event {
    ModelStart {
        model_id: String,
    },
    ModelDone {
        model_id: String,
    },
    FileCached {
        model_id: String,
        file: String,
    },
    FileStart {
        model_id: String,
        file: String,
        bytes_total: u64,
    },
    FileProgress {
        model_id: String,
        file: String,
        bytes: u64,
    },
    FileDone {
        model_id: String,
        file: String,
    },
    BundleStart {
        models: usize,
    },
    BundleDone,
}

#[derive(Default)]
struct FileProgress {
    bytes: u64,
    total: u64,
    reported: u64,
}

#[derive(Default)]
struct DownloadProgress {
    files: HashMap<(String, String), FileProgress>,
}

impl DownloadProgress {
    fn apply(&mut self, event: Event) -> Result<Option<String>> {
        let message = match event {
            Event::BundleStart { models } => format!("downloading {models} model(s)"),
            Event::BundleDone => "model bundle downloaded".into(),
            Event::ModelStart { model_id } => format!("downloading {}", label(&model_id)),
            Event::ModelDone { model_id } => format!("{} downloaded", label(&model_id)),
            Event::FileCached { model_id, file } => {
                format!("{} / {} — cached", label(&model_id), label(&file))
            }
            Event::FileStart {
                model_id,
                file,
                bytes_total,
            } => {
                if self.files.len() >= MAX_FILES {
                    bail!("too many model download files in runtime progress");
                }
                let detail = file_detail(&model_id, &file, 0, bytes_total);
                self.files.insert(
                    (model_id, file),
                    FileProgress {
                        total: bytes_total,
                        ..Default::default()
                    },
                );
                detail
            }
            Event::FileProgress {
                model_id,
                file,
                bytes,
            } => {
                let Some(progress) = self.files.get_mut(&(model_id.clone(), file.clone())) else {
                    // Some mirrors report no file size: show bytes without inventing a total.
                    if self.files.len() >= MAX_FILES {
                        bail!("too many model download files in runtime progress");
                    }
                    self.files.insert(
                        (model_id.clone(), file.clone()),
                        FileProgress {
                            bytes,
                            reported: bytes,
                            total: 0,
                        },
                    );
                    return Ok(Some(file_detail(&model_id, &file, bytes, 0)));
                };
                // hf-hub reports byte deltas, including bytes reused from partial downloads.
                progress.bytes = progress.bytes.saturating_add(bytes);
                if progress.bytes.saturating_sub(progress.reported) < REPORT_BYTES {
                    return Ok(None);
                }
                progress.reported = progress.bytes;
                file_detail(&model_id, &file, progress.bytes, progress.total)
            }
            Event::FileDone { model_id, file } => {
                match self.files.remove(&(model_id.clone(), file.clone())) {
                    Some(progress) => format!(
                        "{} — complete",
                        file_detail(&model_id, &file, progress.bytes, progress.total)
                    ),
                    None => format!("{} / {} — complete", label(&model_id), label(&file)),
                }
            }
        };
        Ok(Some(message))
    }
}

fn label(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(160)
        .collect()
}

fn human_bytes(bytes: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else {
        format!("{bytes} B")
    }
}

fn file_detail(model: &str, file: &str, bytes: u64, total: u64) -> String {
    let size = if total > 0 {
        format!("{} / {}", human_bytes(bytes), human_bytes(total))
    } else {
        human_bytes(bytes)
    };
    format!("{} / {} — {size}", label(model), label(file))
}

/// Read a complete event without allowing a malformed runtime line to grow memory.
async fn read_event_line(
    reader: &mut (impl AsyncBufRead + Unpin),
    line: &mut Vec<u8>,
) -> Result<bool> {
    line.clear();
    loop {
        let available = reader
            .fill_buf()
            .await
            .context("read model download progress")?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let end = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1);
        let consumed = end.unwrap_or(available.len());
        if line.len() + consumed > MAX_EVENT_BYTES {
            bail!("model download progress event exceeds {MAX_EVENT_BYTES} bytes");
        }
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if end.is_some() {
            return Ok(true);
        }
    }
}

/// Stream progress with cancellation and a deadline; never inherit runtime output.
pub(super) async fn run(command: Command, report: &mut impl FnMut(&str)) -> Result<()> {
    run_until_cancel(command, report, async {
        tokio::signal::ctrl_c()
            .await
            .context("listen for download cancellation")
    })
    .await
}

async fn run_until_cancel(
    command: Command,
    report: &mut impl FnMut(&str),
    cancel: impl Future<Output = Result<()>>,
) -> Result<()> {
    let mut command = tokio::process::Command::from(command);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("spawn am-slm models pull")?;
    let stderr = child
        .stderr
        .take()
        .context("capture model download progress")?;
    let mut reader = BufReader::new(stderr);
    let mut progress = DownloadProgress::default();
    let mut last_detail = String::new();
    let operation = async {
        let mut line = Vec::new();
        while read_event_line(&mut reader, &mut line).await? {
            // Runtime diagnostics may share stderr; only the structured protocol is displayed.
            if let Ok(event) = serde_json::from_slice::<Event>(&line)
                && let Some(detail) = progress.apply(event)?
            {
                report(&detail);
                last_detail = detail;
            }
        }
        let status = child.wait().await.context("wait for model download")?;
        if !status.success() {
            bail!("am-slm models pull failed (exit {status})");
        }
        Ok(())
    };
    let result = tokio::select! {
        result = operation => result,
        result = cancel => result.and_then(|()| Err(anyhow::anyhow!("model download cancelled"))),
        () = tokio::time::sleep(DOWNLOAD_TIMEOUT) => Err(anyhow::anyhow!("model download timed out after 2 hours")),
    };
    if let Err(error) = result {
        // Explicitly reap on handled errors; kill_on_drop also covers cancellation of this future.
        child.kill().await.context("stop failed model download")?;
        if last_detail.is_empty() {
            return Err(error);
        }
        return Err(error.context(format!("download interrupted at {last_detail}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
