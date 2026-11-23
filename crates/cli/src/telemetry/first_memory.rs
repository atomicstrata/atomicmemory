//! One durable, install-scoped first-memory envelope. Never enrich on replay.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{ActivationContext, CaptureBody, Ordering, PENDING_CAPTURES, REQUEST_TIMEOUT};
mod store;
use store::{DeliveryState, Store, update_state};

/// Local delivery state. Legacy sent flags are terminal with unknown receipt status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum FirstMemoryState {
    Pending(Pending),
    Accepted { uuid: String },
    Suppressed,
}

/// Frozen non-content analytics fields, without the project credential.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Pending {
    uuid: String,
    timestamp: String,
    distinct_id: String,
    destination: String,
    scope: String,
    properties: serde_json::Map<String, serde_json::Value>,
}

fn scoped_properties(context: &ActivationContext) -> serde_json::Map<String, serde_json::Value> {
    // This event describes an install, not a person. No email hash, subject or
    // identity derived from a later login is retained or added on replay.
    super::context_props(None, context.project_id.as_deref(), context.mode, None)
}

fn same_scope(
    pending: &Pending,
    destination: &str,
    scope: &str,
    properties: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    pending.destination == destination
        && pending.scope == scope
        && pending.properties.get("project_id") == properties.get("project_id")
        && pending.properties.get("mode") == properties.get("mode")
}

/// Snapshot before the memory operation, never derived from a later login.
#[derive(Clone)]
pub(crate) struct ConsentGeneration(Option<String>);

pub(crate) fn begin() -> Option<ConsentGeneration> {
    Store::production()
        .and_then(|store| store.load())
        .ok()
        .map(|cfg| ConsentGeneration(cfg.telemetry_consent_generation))
}

fn reserve_fenced(
    cfg: &mut DeliveryState,
    generation: &ConsentGeneration,
    destination: &str,
    scope: &str,
    properties: serde_json::Map<String, serde_json::Value>,
) -> Option<Pending> {
    if cfg.telemetry_consent_generation != generation.0 {
        // An actual successful milestone completed across a revocation. Never
        // reconstruct it using a subsequent enabled invocation.
        suppress_occurred(cfg);
        return None;
    }
    reserve(cfg, destination, scope, properties)
}

fn reserve(
    cfg: &mut DeliveryState,
    destination: &str,
    scope: &str,
    properties: serde_json::Map<String, serde_json::Value>,
) -> Option<Pending> {
    if cfg.telemetry_first_real_memory_sent == Some(true) {
        return None;
    }
    match cfg.telemetry_first_memory.as_ref() {
        Some(FirstMemoryState::Pending(pending)) => {
            if same_scope(pending, destination, scope, &properties) {
                return Some(pending.clone());
            }
            // A new profile/environment cannot acquire the previous operation.
            cfg.telemetry_first_memory = Some(FirstMemoryState::Suppressed);
            return None;
        }
        Some(_) => return None,
        None => {}
    }
    let distinct_id = cfg
        .telemetry_distinct_id
        .get_or_insert_with(|| format!("cli_{}", uuid::Uuid::now_v7()))
        .clone();
    let pending = Pending {
        uuid: uuid::Uuid::now_v7().to_string(),
        timestamp: super::occurrence_timestamp()?,
        distinct_id,
        destination: destination.to_string(),
        scope: scope.to_string(),
        properties,
    };
    cfg.telemetry_first_memory = Some(FirstMemoryState::Pending(pending.clone()));
    Some(pending)
}

fn pending_matches(cfg: &DeliveryState, uuid: &str) -> bool {
    matches!(&cfg.telemetry_first_memory, Some(FirstMemoryState::Pending(p)) if p.uuid == uuid)
}

fn accept(cfg: &mut DeliveryState, uuid: &str) {
    if pending_matches(cfg, uuid) {
        cfg.telemetry_first_memory = Some(FirstMemoryState::Accepted {
            uuid: uuid.to_string(),
        });
        cfg.telemetry_first_real_memory_sent = Some(true);
    }
}

fn suppress_occurred(cfg: &mut DeliveryState) {
    if cfg.telemetry_first_real_memory_sent != Some(true)
        && !matches!(
            cfg.telemetry_first_memory,
            Some(FirstMemoryState::Accepted { .. })
        )
    {
        cfg.telemetry_first_memory = Some(FirstMemoryState::Suppressed);
    }
}

fn revoke(cfg: &mut DeliveryState) {
    // Rotate even without Pending: an enabled operation may have snapshotted the
    // previous generation and still be waiting for the memory API response.
    cfg.telemetry_consent_generation = Some(uuid::Uuid::now_v7().to_string());
    if matches!(
        cfg.telemetry_first_memory,
        Some(FirstMemoryState::Pending(_))
    ) {
        suppress_occurred(cfg);
    }
}

pub(super) fn suppress() {
    if update_state(|cfg| {
        revoke(cfg);
        Ok(())
    })
    .is_err()
    {
        tracing::warn!("could not persist telemetry suppression");
    }
}

// Account credentials remain part of the boundary: dropping them could replay an
// event after switching accounts at the same URL/project. Rotation intentionally
// suppresses a pending event. A private install salt prevents stable fingerprints
// across installations; it is never sent to the analytics service.
fn scope_fingerprint(salt: &str, profile: &crate::config::ResolvedProfile) -> String {
    let fields = [
        salt,
        &profile.name,
        &profile.base_url,
        &profile.memory_base_url,
        profile.project_id.as_deref().unwrap_or(""),
        profile.api_key.as_deref().unwrap_or(""),
    ];
    let mut hash = Sha256::new();
    for field in fields {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field.as_bytes());
    }
    hex::encode(hash.finalize())
}

pub(super) fn capture(
    memories_stored: i32,
    source: &str,
    context: &ActivationContext,
    profile: &crate::config::ResolvedProfile,
    no_telemetry: bool,
    generation: Option<ConsentGeneration>,
) {
    if memories_stored <= 0 || super::is_smoke_scope(source) {
        return;
    }
    if !super::telemetry_enabled(no_telemetry) {
        if update_state(|cfg| {
            revoke(cfg);
            suppress_occurred(cfg);
            Ok(())
        })
        .is_err()
        {
            tracing::warn!("could not persist telemetry suppression");
        }
        return;
    }
    let Some(generation) = generation else {
        return;
    };
    let Some(api_key) = super::posthog_api_key() else {
        return;
    };
    let host = std::env::var("AM_POSTHOG_HOST")
        .or_else(|_| std::env::var("NEXT_PUBLIC_POSTHOG_HOST"))
        .unwrap_or_else(|_| super::DEFAULT_POSTHOG_HOST.to_string());
    let url = format!("{}/capture/", host.trim_end_matches('/'));
    let destination = hex::encode(Sha256::digest(format!("{url}\0{api_key}")));
    let install_id = super::distinct_id();
    let Ok(Some(pending)) = update_state(|cfg| {
        cfg.telemetry_distinct_id.get_or_insert(install_id);
        let salt = cfg
            .scope_salt
            .get_or_insert_with(|| uuid::Uuid::now_v7().to_string());
        let scope = scope_fingerprint(salt, profile);
        Ok(reserve_fenced(
            cfg,
            &generation,
            &destination,
            &scope,
            scoped_properties(context),
        ))
    }) else {
        return;
    };
    PENDING_CAPTURES.fetch_add(1, Ordering::AcqRel);
    tokio::spawn(async move {
        let body = CaptureBody {
            api_key,
            uuid: pending.uuid.clone(),
            timestamp: pending.timestamp,
            distinct_id: pending.distinct_id,
            event: super::ActivationEvent::FirstRealMemoryCreated.as_str(),
            properties: pending.properties,
        };
        let Ok(client) = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
        else {
            PENDING_CAPTURES.fetch_sub(1, Ordering::AcqRel);
            return;
        };
        // Concurrent invocations reserve the same envelope under the config
        // lock. Their transmissions are identical for provider deduplication.
        let accepted = super::send_capture_if(&client, &url, &body, || {
            super::telemetry_enabled(no_telemetry)
                && Store::production()
                    .and_then(|store| store.load())
                    .is_ok_and(|cfg| pending_matches(&cfg, &pending.uuid))
        })
        .await;
        if accepted
            && update_state(|cfg| {
                accept(cfg, &pending.uuid);
                Ok(())
            })
            .is_err()
        {
            tracing::warn!("telemetry acceptance could not be recorded");
        }
        PENDING_CAPTURES.fetch_sub(1, Ordering::AcqRel);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn props(project: &str) -> serde_json::Map<String, serde_json::Value> {
        scoped_properties(&ActivationContext {
            project_id: Some(project.into()),
            mode: Some("cloud"),
            email_hash: Some("must-not-persist".into()),
            ..Default::default()
        })
    }
    #[test]
    fn scope_fingerprint_is_install_salted_and_account_bound() {
        let mut profile = crate::config::ResolvedProfile {
            name: "test".into(),
            base_url: "https://example.test".into(),
            memory_base_url: "https://example.test".into(),
            kind: crate::config::ProfileKind::Cloud,
            project_id: Some("p".into()),
            api_key: Some("never-persist-this-key".into()),
            oauth: None,
        };
        let original = scope_fingerprint("install-a", &profile);
        assert_eq!(original, scope_fingerprint("install-a", &profile));
        assert_ne!(original, scope_fingerprint("install-b", &profile));
        assert!(!original.contains("never-persist-this-key"));
        profile.api_key = Some("rotated-key".into());
        assert_ne!(original, scope_fingerprint("install-a", &profile));
    }

    #[test]
    fn salt_survives_reload_and_old_unsalted_pending_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::at(dir.path().join("delivery.toml"));
        store
            .update(|cfg| {
                cfg.scope_salt = Some("private-install-salt".into());
                reserve(cfg, "d", "old-unsalted-scope", props("p"));
                Ok(())
            })
            .unwrap();
        store
            .update(|cfg| {
                assert_eq!(cfg.scope_salt.as_deref(), Some("private-install-salt"));
                assert!(reserve(cfg, "d", "new-salted-scope", props("p")).is_none());
                Ok(())
            })
            .unwrap();
        let restored = store.load().unwrap();
        assert_eq!(restored.scope_salt.as_deref(), Some("private-install-salt"));
        assert!(matches!(
            restored.telemetry_first_memory,
            Some(FirstMemoryState::Suppressed)
        ));
    }

    #[test]
    fn reserve_and_crash_reload_preserve_exact_envelope() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::at(dir.path().join("config.toml"));
        let first = store
            .update(|cfg| Ok(reserve(cfg, "destination", "scope", props("p1")).unwrap()))
            .unwrap();
        let restored = Store::at(store.path().to_path_buf())
            .update(|cfg| Ok(reserve(cfg, "destination", "scope", props("p1")).unwrap()))
            .unwrap();
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            serde_json::to_value(restored).unwrap()
        );
        let text = std::fs::read_to_string(store.path()).unwrap();
        assert!(!text.contains("must-not-persist"));
        assert!(!text.contains("api_key"));
    }
    #[test]
    fn suppression_fences_late_ack_and_reenable() {
        let mut cfg = DeliveryState::default();
        let pending = reserve(&mut cfg, "d", "scope", props("p")).unwrap();
        revoke(&mut cfg);
        accept(&mut cfg, &pending.uuid);
        assert!(matches!(
            cfg.telemetry_first_memory,
            Some(FirstMemoryState::Suppressed)
        ));
        assert!(reserve(&mut cfg, "d", "scope", props("p")).is_none());
        assert_ne!(cfg.telemetry_first_real_memory_sent, Some(true));
    }
    #[test]
    fn optout_before_reservation_fences_stale_sender() {
        let mut cfg = DeliveryState::default();
        let stale = ConsentGeneration(cfg.telemetry_consent_generation.clone());
        revoke(&mut cfg);
        assert!(cfg.telemetry_first_memory.is_none());
        assert!(reserve_fenced(&mut cfg, &stale, "d", "scope", props("p")).is_none());
        assert!(matches!(
            cfg.telemetry_first_memory,
            Some(FirstMemoryState::Suppressed)
        ));
        assert!(cfg.telemetry_distinct_id.is_none());
    }

    #[test]
    fn repeated_optout_fences_new_inflight_operation_without_pending() {
        let mut cfg = DeliveryState::default();
        revoke(&mut cfg);
        let inflight = ConsentGeneration(cfg.telemetry_consent_generation.clone());
        revoke(&mut cfg);
        assert!(cfg.telemetry_first_memory.is_none());
        assert!(reserve_fenced(&mut cfg, &inflight, "d", "scope", props("p")).is_none());
        assert!(matches!(
            cfg.telemetry_first_memory,
            Some(FirstMemoryState::Suppressed)
        ));
    }

    #[test]
    fn unrelated_optout_does_not_consume_future_first_milestone() {
        let mut cfg = DeliveryState::default();
        revoke(&mut cfg);
        let future = ConsentGeneration(cfg.telemetry_consent_generation.clone());
        assert!(reserve_fenced(&mut cfg, &future, "d", "scope", props("p")).is_some());
    }

    #[test]
    fn opted_out_actual_milestone_cannot_be_backfilled() {
        let mut cfg = DeliveryState::default();
        revoke(&mut cfg);
        suppress_occurred(&mut cfg);
        let future = ConsentGeneration(cfg.telemetry_consent_generation.clone());
        assert!(reserve_fenced(&mut cfg, &future, "d", "scope", props("p")).is_none());
    }

    #[test]
    fn destination_and_project_change_never_replay() {
        for (destination, project) in [("other", "p"), ("d", "other")] {
            let mut cfg = DeliveryState::default();
            reserve(&mut cfg, "d", "scope", props("p")).unwrap();
            assert!(reserve(&mut cfg, destination, "scope", props(project)).is_none());
            assert!(matches!(
                cfg.telemetry_first_memory,
                Some(FirstMemoryState::Suppressed)
            ));
        }
    }
    #[test]
    fn profile_or_credentials_scope_change_suppresses_original() {
        let mut cfg = DeliveryState::default();
        reserve(&mut cfg, "d", "old-scope", props("p")).unwrap();
        assert!(reserve(&mut cfg, "d", "new-scope", props("p")).is_none());
        assert!(matches!(
            cfg.telemetry_first_memory,
            Some(FirstMemoryState::Suppressed)
        ));
    }

    #[test]
    fn legacy_and_accepted_states_are_terminal() {
        let mut cfg = DeliveryState {
            telemetry_first_real_memory_sent: Some(true),
            ..Default::default()
        };
        assert!(reserve(&mut cfg, "d", "scope", props("p")).is_none());
        let mut cfg = DeliveryState::default();
        let pending = reserve(&mut cfg, "d", "scope", props("p")).unwrap();
        accept(&mut cfg, "wrong-id");
        assert!(pending_matches(&cfg, &pending.uuid));
        accept(&mut cfg, &pending.uuid);
        assert!(reserve(&mut cfg, "d", "scope", props("p")).is_none());
    }
    #[test]
    fn concurrent_reservations_have_one_uuid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    Store::at(path)
                        .update(|cfg| Ok(reserve(cfg, "d", "scope", props("p")).unwrap().uuid))
                        .unwrap()
                })
            })
            .collect();
        let ids: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
    }
}
