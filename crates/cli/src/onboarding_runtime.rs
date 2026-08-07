//! Poll Cloud runtime registry until a runtime is online or timeout.

use std::time::Duration;

use am_cloud_types::RuntimePresence;

use crate::cli::GlobalOptions;
use crate::commands::client::dashboard_client;
use crate::progress::ProgressReporter;

const DEFAULT_WAIT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[allow(dead_code)]
pub async fn wait_runtime_online(
    global: &GlobalOptions,
    project_id: &str,
    timeout: Duration,
) -> bool {
    wait_runtime_online_with_progress(global, project_id, timeout, None).await
}

pub async fn wait_runtime_online_with_progress(
    global: &GlobalOptions,
    project_id: &str,
    timeout: Duration,
    mut progress: Option<&mut dyn ProgressReporter>,
) -> bool {
    let started = tokio::time::Instant::now();
    let deadline = started + timeout;
    while tokio::time::Instant::now() < deadline {
        if runtime_online_now(global, project_id).await {
            return true;
        }
        let elapsed = started.elapsed().as_secs();
        if let Some(p) = progress.as_deref_mut() {
            p.tick("heartbeat", &format!("{elapsed}s/{}s", timeout.as_secs()));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    runtime_online_now(global, project_id).await
}

pub async fn runtime_online_now(global: &GlobalOptions, project_id: &str) -> bool {
    let Ok((_profile, dash)) = dashboard_client(global).await else {
        return false;
    };
    let Ok(runtimes) = dash.list_runtimes(project_id).await else {
        return false;
    };
    runtimes
        .iter()
        .any(|r| r.presence == RuntimePresence::Online)
}

pub fn default_runtime_wait() -> Duration {
    DEFAULT_WAIT
}
