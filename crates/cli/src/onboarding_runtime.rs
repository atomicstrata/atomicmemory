//! Poll Cloud runtime registry until a runtime is online or timeout.

use std::time::Duration;

use crate::instance::docker::{DockerRunner, RealDockerRunner};
use crate::instance::{DEFAULT_CONTAINER_NAME, address::ManagedAddress, storage::owned_storage};
use am_cloud_types::{RuntimePresence, RuntimeSummary};
use anyhow::{Context, Result, bail};

use crate::cli::GlobalOptions;
use crate::commands::client::dashboard_client;
use crate::progress::ProgressReporter;

const DEFAULT_WAIT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const IDENTITY_INSPECT_TIMEOUT: Duration = Duration::from_secs(10);

#[allow(dead_code)]
pub async fn wait_runtime_online(
    global: &GlobalOptions,
    project_id: &str,
    instance_id: &str,
    timeout: Duration,
) -> bool {
    wait_runtime_online_with_progress(global, project_id, instance_id, timeout, None).await
}

pub async fn wait_runtime_online_with_progress(
    global: &GlobalOptions,
    project_id: &str,
    instance_id: &str,
    timeout: Duration,
    mut progress: Option<&mut dyn ProgressReporter>,
) -> bool {
    if instance_id.is_empty() {
        return false;
    }
    let started = tokio::time::Instant::now();
    tokio::time::timeout(timeout, async {
        loop {
            if runtime_online_now(global, project_id, instance_id).await {
                return true;
            }
            if let Some(p) = progress.as_deref_mut() {
                p.tick(
                    "heartbeat",
                    &format!("{}s/{}s", started.elapsed().as_secs(), timeout.as_secs()),
                );
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    })
    .await
    .unwrap_or(false)
}

pub async fn runtime_online_now(
    global: &GlobalOptions,
    project_id: &str,
    instance_id: &str,
) -> bool {
    let Ok((_profile, dash)) = dashboard_client(global).await else {
        return false;
    };
    let Ok(runtimes) = dash.list_runtimes(project_id).await else {
        return false;
    };
    matching_runtime_online(&runtimes, project_id, instance_id)
}

fn matching_runtime_online(
    runtimes: &[RuntimeSummary],
    project_id: &str,
    instance_id: &str,
) -> bool {
    !instance_id.is_empty()
        && runtimes.iter().any(|runtime| {
            runtime.project_id == project_id
                && runtime.core_instance_id == instance_id
                && runtime.presence == RuntimePresence::Online
                && runtime.revoked_at.is_none()
        })
}

/// Resolve the exact local Core identity only after checking managed ownership and binding.
pub async fn managed_core_instance_id(global: &GlobalOptions) -> Result<String> {
    let profile = crate::config::resolve_profile(
        global.profile.as_deref(),
        global.base_url.as_deref(),
        global.environment,
    )?;
    // Keep CLI lifecycle commands from replacing the container between inspection and read.
    let _registry = crate::instance::storage::RuntimeStore::open()?;
    managed_core_instance_id_with(&RealDockerRunner::new(), &profile).await
}

async fn managed_core_instance_id_with(
    docker: &dyn DockerRunner,
    profile: &crate::config::ResolvedProfile,
) -> Result<String> {
    let expected = ManagedAddress::parse(&profile.memory_base_url)?;
    let inspected = tokio::time::timeout(
        IDENTITY_INSPECT_TIMEOUT,
        docker.inspect(DEFAULT_CONTAINER_NAME),
    )
    .await
    .context("inspect Core runtime identity timed out")??
    .context("managed Core is missing; cloud connection cannot be verified")?;
    let bound = inspected
        .local_url
        .as_deref()
        .and_then(|url| ManagedAddress::parse(url).ok());
    if !inspected.state.is_running()
        || owned_storage(profile, Some(&inspected)).is_none()
        || bound != Some(expected)
    {
        bail!(
            "Core runtime ownership or local binding could not be verified; refusing to read its identity"
        );
    }
    docker
        .read_core_instance_id(DEFAULT_CONTAINER_NAME)
        .await?
        .filter(|id| !id.is_empty())
        .context("persisted Core runtime identity is missing; cloud connection cannot be verified")
}

pub fn default_runtime_wait() -> Duration {
    DEFAULT_WAIT
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> RuntimeSummary {
        RuntimeSummary {
            id: "registry-row".into(),
            project_id: "project-one".into(),
            core_instance_id: "this-machine".into(),
            name: None,
            runtime_type: "core".into(),
            presence: RuntimePresence::Online,
            capabilities: Vec::new(),
            core_version: None,
            connector_version: None,
            last_heartbeat_at: Some(chrono::Utc::now()),
            revoked_at: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn another_online_machine_cannot_activate_this_installation() {
        assert!(!matching_runtime_online(
            &[runtime()],
            "project-one",
            "different-machine"
        ));
    }

    #[test]
    fn matching_online_instance_requires_project_and_unrevoked_state() {
        let expected = runtime();
        assert!(matching_runtime_online(
            std::slice::from_ref(&expected),
            "project-one",
            "this-machine"
        ));
        assert!(!matching_runtime_online(
            std::slice::from_ref(&expected),
            "different-project",
            "this-machine"
        ));
        let mut revoked = expected.clone();
        revoked.revoked_at = Some(chrono::Utc::now());
        assert!(!matching_runtime_online(
            &[revoked],
            "project-one",
            "this-machine"
        ));
        let mut offline = expected;
        offline.presence = RuntimePresence::Offline;
        assert!(!matching_runtime_online(
            &[offline],
            "project-one",
            "this-machine"
        ));
    }
}

#[cfg(all(test, unix))]
mod ownership_tests {
    use super::*;
    use serde_json::{Value, json};
    use std::os::unix::fs::PermissionsExt;

    fn profile() -> crate::config::ResolvedProfile {
        crate::config::ResolvedProfile {
            name: "local-test".into(),
            base_url: "https://api.example.test".into(),
            kind: crate::config::ProfileKind::Local,
            project_id: Some("project-one".into()),
            memory_base_url: "http://127.0.0.1:17352".into(),
            api_key: None,
            oauth: None,
        }
    }

    fn inspect() -> Value {
        json!([{
            "State":{"Status":"running"},
            "Config":{"Image":"example/core:test","Labels":{
                "ai.atomicstrata.managed-by":"am-cli", "ai.atomicstrata.profile":"local-test",
                "ai.atomicstrata.project-id":"project-one"
            },"Env":["OPENAI_API_KEY=fixture-key","EMBEDDING_DIMENSIONS=1536","ATOMICMEMORY_API_URL=https://api.example.test"]},
            "Mounts":[
                {"Type":"volume","Name":"data-test","Destination":"/var/lib/atomicmemory/postgres"},
                {"Type":"volume","Name":"state-test","Destination":"/var/lib/atomicmemory/state"}
            ],
            "NetworkSettings":{"Ports":{"17350/tcp":[{"HostIp":"127.0.0.1","HostPort":"17352"}]}}
        }])
    }

    fn fake_docker(inspected: &Value, id: &str) -> (tempfile::TempDir, RealDockerRunner) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("inspect.json"), inspected.to_string()).unwrap();
        std::fs::write(dir.path().join("identity"), id).unwrap();
        let executable = dir.path().join("docker");
        let script = r#"#!/bin/sh
script_dir=$(dirname "$0")
case "$1" in
  inspect) cat "$script_dir/inspect.json";;
  exec)
    test "$2" = atomic-memory && test "$3" = cat && test "$4" = /var/lib/atomicmemory/state/core-instance-id || exit 9
    touch "$script_dir/read-called"
    cat "$script_dir/identity";;
  *) exit 8;;
esac
"#;
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let docker = RealDockerRunner {
            docker_bin: executable.to_string_lossy().into_owned(),
        };
        (dir, docker)
    }

    #[tokio::test]
    async fn reads_only_the_owned_running_instances_persisted_identity() {
        let (dir, docker) = fake_docker(&inspect(), "this-machine\n");
        assert_eq!(
            managed_core_instance_id_with(&docker, &profile())
                .await
                .unwrap(),
            "this-machine"
        );
        assert!(dir.path().join("read-called").exists());
    }

    #[tokio::test]
    async fn identity_is_never_read_from_wrong_owner_project_or_binding() {
        let mut wrong_profile = inspect();
        wrong_profile[0]["Config"]["Labels"]["ai.atomicstrata.profile"] = json!("another-profile");
        let mut wrong_project = inspect();
        wrong_project[0]["Config"]["Labels"]["ai.atomicstrata.project-id"] =
            json!("another-project");
        let mut wrong_binding = inspect();
        wrong_binding[0]["NetworkSettings"]["Ports"]["17350/tcp"][0]["HostPort"] = json!("18888");
        for inspected in [wrong_profile, wrong_project, wrong_binding] {
            let (dir, docker) = fake_docker(&inspected, "other-machine");
            assert!(
                managed_core_instance_id_with(&docker, &profile())
                    .await
                    .is_err()
            );
            assert!(!dir.path().join("read-called").exists());
        }
    }

    #[tokio::test]
    async fn missing_or_oversized_identity_cannot_verify_cloud_connection() {
        for id in [String::new(), "x".repeat(4096)] {
            let (_dir, docker) = fake_docker(&inspect(), &id);
            assert!(
                managed_core_instance_id_with(&docker, &profile())
                    .await
                    .is_err()
            );
        }
    }
}
