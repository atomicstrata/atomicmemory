//! Shared auth-wait heartbeats for OAuth callback and device polling.

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tokio::sync::oneshot;
use tokio::time;

use crate::progress::ProgressReporter;

const AUTH_TICK_INTERVAL: Duration = Duration::from_secs(1);

pub async fn wait_for_oneshot<T>(
    mut rx: oneshot::Receiver<T>,
    mut progress: Option<&mut dyn ProgressReporter>,
    step_id: &str,
    wait: Duration,
    detail_prefix: &str,
) -> Result<T> {
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + wait;
    let mut next_tick = tokio::time::Instant::now();
    let poll = Duration::from_millis(200);

    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow::anyhow!(
                "authentication timed out after {}s",
                wait.as_secs()
            ));
        }

        if tokio::time::Instant::now() >= next_tick {
            if let Some(reporter) = progress.as_deref_mut() {
                let elapsed = started.elapsed().as_secs();
                reporter.tick(
                    step_id,
                    &format!("{detail_prefix} ({elapsed}s/{})", wait.as_secs()),
                );
            }
            next_tick = tokio::time::Instant::now() + AUTH_TICK_INTERVAL;
        }

        tokio::select! {
            result = &mut rx => return result.context("callback channel closed"),
            _ = time::sleep(poll) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::ProgressReporter;

    struct RecordingReporter {
        ticks: Vec<String>,
    }

    impl ProgressReporter for RecordingReporter {
        fn start_step(&mut self, _id: &str, _label: &str) {}
        fn tick(&mut self, id: &str, detail: &str) {
            self.ticks.push(format!("{id}:{detail}"));
        }
        fn succeed(&mut self, _id: &str, _detail: Option<&str>) {}
        fn warn(&mut self, _id: &str, _detail: Option<&str>) {}
        fn fail(&mut self, _id: &str, _detail: Option<&str>) {}
        fn finish(&mut self) {}
    }

    #[tokio::test]
    async fn wait_for_oneshot_completes_when_sender_fires() {
        let (tx, rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            time::sleep(Duration::from_millis(50)).await;
            let _ = tx.send("done");
        });
        let result = wait_for_oneshot(
            rx,
            None,
            "identity",
            Duration::from_secs(2),
            "waiting for browser",
        )
        .await
        .unwrap();
        assert_eq!(result, "done");
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn wait_for_oneshot_emits_progress_ticks() {
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            time::sleep(Duration::from_millis(1100)).await;
            let _ = tx.send(());
        });
        let mut reporter = RecordingReporter { ticks: vec![] };
        wait_for_oneshot(
            rx,
            Some(&mut reporter),
            "identity",
            Duration::from_secs(5),
            "waiting for browser",
        )
        .await
        .unwrap();
        assert!(
            reporter
                .ticks
                .iter()
                .any(|t| t.contains("waiting for browser"))
        );
    }

    #[tokio::test]
    async fn wait_for_oneshot_times_out() {
        let (_tx, rx) = oneshot::channel::<()>();
        let err = wait_for_oneshot(rx, None, "identity", Duration::from_millis(50), "waiting")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"));
    }
}
