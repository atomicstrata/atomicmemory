//! Deterministic runtime event and subprocess contract tests.

use super::*;

#[test]
fn accumulates_byte_deltas_and_reports_known_totals() {
    let mut state = DownloadProgress::default();
    state
        .apply(Event::FileStart {
            model_id: "qwen".into(),
            file: "weights".into(),
            bytes_total: 33554432,
        })
        .unwrap();
    state
        .apply(Event::FileProgress {
            model_id: "qwen".into(),
            file: "weights".into(),
            bytes: 8388608,
        })
        .unwrap();
    let detail = state
        .apply(Event::FileProgress {
            model_id: "qwen".into(),
            file: "weights".into(),
            bytes: 8388608,
        })
        .unwrap()
        .unwrap();
    assert!(detail.contains("16.0 MiB / 32.0 MiB"));
    assert!(!detail.contains('%'));
}

#[test]
fn unknown_size_and_cache_hits_do_not_invent_a_total() {
    let mut state = DownloadProgress::default();
    let detail = state
        .apply(Event::FileProgress {
            model_id: "qwen".into(),
            file: "weights".into(),
            bytes: 42,
        })
        .unwrap()
        .unwrap();
    assert!(detail.ends_with("42 B"));
    let cached = state
        .apply(Event::FileCached {
            model_id: "qwen".into(),
            file: "config".into(),
        })
        .unwrap()
        .unwrap();
    assert!(cached.ends_with("cached"));
    assert!(!cached.contains('%'));
}

#[test]
fn bounds_tracked_files_and_rate_of_byte_updates() {
    let mut state = DownloadProgress::default();
    for i in 0..MAX_FILES {
        state
            .apply(Event::FileStart {
                model_id: "qwen".into(),
                file: i.to_string(),
                bytes_total: 100,
            })
            .unwrap();
    }
    assert!(
        state
            .apply(Event::FileStart {
                model_id: "qwen".into(),
                file: "overflow".into(),
                bytes_total: 100
            })
            .is_err()
    );
    for _ in 0..1000 {
        assert!(
            state
                .apply(Event::FileProgress {
                    model_id: "qwen".into(),
                    file: "0".into(),
                    bytes: 1
                })
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test]
async fn rejects_oversize_stderr_without_reading_unbounded_lines() {
    let bytes = vec![b'x'; MAX_EVENT_BYTES + 1];
    let mut reader = BufReader::new(bytes.as_slice());
    let mut line = Vec::new();
    let error = read_event_line(&mut reader, &mut line).await.unwrap_err();
    assert!(error.to_string().contains("exceeds"));
    assert!(line.len() <= MAX_EVENT_BYTES);
}

#[cfg(unix)]
fn script(body: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", body]);
    command
}

#[tokio::test]
#[cfg(unix)]
async fn subprocess_only_forwards_structured_stderr_and_drains_stdout() {
    let command = script(
        r#"
        printf '%s\n' '{"event":"model_start","model_id":"qwen","revision":"main"}' >&2
        printf '%s\n' '{"event":"file_cached","model_id":"qwen","file":"config","path":"private"}' >&2
        printf '%s\n' 'diagnostic with private data' >&2
        dd if=/dev/zero bs=1024 count=128 2>/dev/null
        printf '%s\n' '{"event":"model_done","model_id":"qwen"}' >&2
    "#,
    );
    let mut reports = Vec::new();
    run_until_cancel(
        command,
        &mut |detail| reports.push(detail.to_string()),
        std::future::pending(),
    )
    .await
    .unwrap();
    assert_eq!(
        reports,
        [
            "downloading qwen",
            "qwen / config — cached",
            "qwen downloaded"
        ]
    );
}

#[tokio::test]
#[cfg(unix)]
async fn subprocess_failure_keeps_model_context() {
    let command =
        script(r#"printf '%s\n' '{"event":"model_start","model_id":"qwen"}' >&2; exit 7"#);
    let error = run_until_cancel(command, &mut |_| {}, std::future::pending())
        .await
        .unwrap_err();
    let detail = format!("{error:#}");
    assert!(detail.contains("qwen"));
    assert!(detail.contains('7'));
}

#[tokio::test]
#[cfg(unix)]
async fn cancellation_kills_and_reaps_the_child() {
    let command = script(
        r#"printf '{"event":"model_start","model_id":"%s"}\n' "$$" >&2; while :; do :; done"#,
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut tx = Some(tx);
    let mut pid = None;
    // The child is started before the first event; cancellation follows that event, without sleeps.
    let error = run_until_cancel(
        command,
        &mut |detail| {
            pid = Some(
                detail
                    .strip_prefix("downloading ")
                    .unwrap()
                    .parse::<u32>()
                    .unwrap(),
            );
            if let Some(tx) = tx.take() {
                tx.send(()).unwrap();
            }
        },
        async { rx.await.context("cancel test") },
    )
    .await
    .unwrap_err();
    assert!(!crate::slm::process::pid_alive(pid.unwrap()));
    assert!(error.to_string().contains("download interrupted"));
    assert!(format!("{error:#}").contains("cancelled"));
}

#[tokio::test]
#[cfg(unix)]
async fn download_deadline_kills_a_child_that_stops_reporting() {
    let command = script(
        r#"printf '{"event":"model_start","model_id":"%s"}\n' "$$" >&2; while :; do :; done"#,
    );
    let mut pid = None;
    let error = run_until_cancel(
        command,
        &mut |detail| {
            pid = Some(
                detail
                    .strip_prefix("downloading ")
                    .unwrap()
                    .parse::<u32>()
                    .unwrap(),
            );
            // Advance only after the child is known to be running, without a wall-clock sleep.
            tokio::time::pause();
        },
        std::future::pending(),
    )
    .await
    .unwrap_err();
    assert!(format!("{error:#}").contains("timed out"));
    assert!(!crate::slm::process::pid_alive(pid.unwrap()));
}
