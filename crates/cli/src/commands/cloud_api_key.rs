//! Cloud API key provisioning for Connected Local (`connected-local-runtime`).
//!
//! Singleton policy: reuse a working locally stored `amc_` key; otherwise rotate
//! an existing active key with this name, and only create when none exists. That
//! keeps `am init` / `am instance start` from burning free-plan key quota.

use am_cloud_client::{CloudClientError, DashboardClient, MemoryClient};
use am_cloud_types::{ApiKey, CreateApiKeyRequest};
use anyhow::{Context, Result, bail};
use tracing::info;
use url::Url;

use crate::auth::origin::same_origin;
use crate::cli::GlobalOptions;
use crate::commands::client::{cloud_api_key_client, dashboard_client};
use crate::config::{
    ResolvedProfile, is_cloud_api_key, require_api_key, require_project_id, store_api_key,
};
use crate::instance::AUTO_KEY_NAME;
use crate::output::message;

/// How a Connected Local Cloud API key was obtained for this run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvisionOutcome {
    /// Locally stored `amc_` key still mints against this Cloud origin.
    Reused,
    /// Rotated an existing active `connected-local-runtime` key (quota-safe).
    Rotated { key_id: String },
    /// Created a new `connected-local-runtime` key (none existed).
    Created { key_id: String },
}

impl ProvisionOutcome {
    /// Short progress-step detail (wizard / init).
    pub fn progress_detail(&self) -> &'static str {
        match self {
            Self::Reused => "reused stored key",
            Self::Rotated { .. } => "rotated existing connected-local-runtime",
            Self::Created { .. } => "created connected-local-runtime",
        }
    }

    /// True when Core must be recreated so `ATOMICMEMORY_API_KEY` env matches the new secret.
    pub fn requires_container_sync(&self) -> bool {
        matches!(self, Self::Created { .. } | Self::Rotated { .. })
    }

    /// Operator-facing stderr line when something changed (rotate/create).
    pub fn operator_message(&self) -> Option<String> {
        match self {
            Self::Reused => None,
            Self::Rotated { key_id } => Some(format!(
                "Rotated existing Cloud API key '{AUTO_KEY_NAME}' ({key_id}) — quota-safe; \
                 previous secret is invalidated and the new secret is saved locally (not printed)."
            )),
            Self::Created { key_id } => Some(format!(
                "Created Cloud API key '{AUTO_KEY_NAME}' ({key_id}) and saved locally (not printed)."
            )),
        }
    }
}

/// Pick which listed key to rotate for the Connected Local singleton.
///
/// Prefers `active` keys named [`AUTO_KEY_NAME`], then most recently used, then
/// newest `created_at`. Returns `None` when create is required.
pub fn select_runtime_key_for_rotate(keys: &[ApiKey]) -> Option<&ApiKey> {
    let mut candidates: Vec<&ApiKey> = keys
        .iter()
        .filter(|k| k.name == AUTO_KEY_NAME && status_is_active(&k.status))
        .collect();
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by(|a, b| {
        b.last_used_at
            .cmp(&a.last_used_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
    candidates.into_iter().next()
}

fn status_is_active(status: &str) -> bool {
    status.eq_ignore_ascii_case("active")
}

/// Whether a failed mint probe means the stored Cloud key should be rotated.
pub fn should_rotate_after_probe(err: &CloudClientError) -> bool {
    matches!(err, CloudClientError::Auth)
}

fn is_api_key_quota_exceeded(err: &CloudClientError) -> bool {
    match err {
        CloudClientError::Status { code, body } => {
            *code == 429
                && (body.contains("max_api_keys")
                    || body.contains("quota_exceeded")
                    || body.contains("quota exceeded"))
        }
        _ => false,
    }
}

/// Ensure the profile has a working Connected Local Cloud API key.
///
/// Returns the secret and how it was obtained. Origin drift between the command
/// profile and the live dashboard profile fails closed before mint/rotate.
pub async fn ensure_connected_local_cloud_api_key(
    global: &GlobalOptions,
    profile: &ResolvedProfile,
) -> Result<(String, ProvisionOutcome)> {
    if let Ok(key) = require_api_key(profile)
        && is_cloud_api_key(&key)
    {
        match probe_cloud_api_key_mint(&profile.base_url, &key).await {
            Ok(()) => return Ok((key, ProvisionOutcome::Reused)),
            Err(err) if should_rotate_after_probe(&err) => {
                info!(
                    profile = %profile.name,
                    "stored Cloud API key rejected; rotating or creating connected-local-runtime"
                );
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    base_url = %profile.base_url,
                    "could not verify Cloud API key against tier; continuing with stored key"
                );
                return Ok((key, ProvisionOutcome::Reused));
            }
        }
    }

    let project_id = require_project_id(profile, None)?;
    let (mint_profile, client) = dashboard_client(global).await?;
    if !same_origin(&mint_profile.base_url, &profile.base_url) {
        bail!(
            "active profile changed from '{}' ({}) to '{}' ({}) while provisioning a Cloud API key — \
             re-run so the key is created and stored against one origin",
            profile.name,
            profile.base_url,
            mint_profile.name,
            mint_profile.base_url
        );
    }

    let (secret, outcome) =
        rotate_or_create_runtime_key(&client, &project_id, &profile.name, &profile.base_url)
            .await?;
    probe_cloud_api_key_mint(&profile.base_url, &secret).await?;
    if let Some(msg) = outcome.operator_message() {
        message(!global.quiet, &msg);
    }
    Ok((secret, outcome))
}

/// Init / connect-project path: ensure a stored key that can mint, without
/// returning the secret to the caller.
pub async fn ensure_connected_local_cloud_api_key_stored(
    global: &GlobalOptions,
    profile_name: &str,
    project_id: &str,
) -> Result<ProvisionOutcome> {
    if let Ok((resolved, client)) = cloud_api_key_client(global).await {
        // The client resolves the ACTIVE profile, which need not be the profile
        // whose project this call is provisioning for. A key that mints happily
        // for the active profile's project is still the wrong key for this one,
        // so reuse requires the projects to agree. Selection already refuses a
        // key whose stored project does not match its own profile; this closes
        // the remaining gap between "the resolved profile" and "the requested
        // project".
        let same_project = resolved.project_id.as_deref() == Some(project_id);
        match client.mint_local_token().await {
            Ok(_) if same_project => return Ok(ProvisionOutcome::Reused),
            Ok(_) => {
                info!(
                    profile = %profile_name,
                    "stored Cloud API key belongs to a different project; provisioning one for this project"
                );
            }
            Err(err) if should_rotate_after_probe(&err) => {
                info!(
                    profile = %profile_name,
                    "stored Cloud API key rejected; rotating or creating connected-local-runtime"
                );
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    profile = %profile_name,
                    "Cloud API key probe failed; preserving stored key (not rotating)"
                );
                return Ok(ProvisionOutcome::Reused);
            }
        }
    }

    let (profile, client) = dashboard_client(global).await?;
    let (_secret, outcome) =
        rotate_or_create_runtime_key(&client, project_id, profile_name, &profile.base_url).await?;
    if let Some(msg) = outcome.operator_message() {
        message(!global.quiet, &msg);
    }
    Ok(outcome)
}

async fn rotate_or_create_runtime_key(
    client: &DashboardClient,
    project_id: &str,
    profile_name: &str,
    api_origin: &str,
) -> Result<(String, ProvisionOutcome)> {
    let keys = client
        .list_api_keys(project_id)
        .await
        .context("list Cloud API keys")?;

    if let Some(existing) = select_runtime_key_for_rotate(&keys) {
        info!(
            key_id = %existing.id,
            name = %existing.name,
            "rotating existing Connected Local Cloud API key"
        );
        let rotated = client
            .rotate_api_key(project_id, &existing.id)
            .await
            .with_context(|| {
                format!("rotate Cloud API key '{}' ({})", existing.name, existing.id)
            })?;
        store_api_key(profile_name, &rotated.secret, api_origin, project_id)?;
        return Ok((
            rotated.secret,
            ProvisionOutcome::Rotated {
                key_id: rotated.key.id,
            },
        ));
    }

    info!(
        name = AUTO_KEY_NAME,
        "creating Connected Local Cloud API key"
    );
    match client
        .create_api_key(
            project_id,
            &CreateApiKeyRequest {
                name: AUTO_KEY_NAME.to_string(),
                environment: None,
            },
        )
        .await
    {
        Ok(created) => {
            store_api_key(profile_name, &created.secret, api_origin, project_id)?;
            Ok((
                created.secret,
                ProvisionOutcome::Created {
                    key_id: created.key.id,
                },
            ))
        }
        Err(err) if is_api_key_quota_exceeded(&err) => {
            // Race: list saw no active singleton but quota is full (revoked leftovers,
            // or another client created keys). Prefer rotating any same-named key.
            if let Some(any_named) = keys.iter().find(|k| k.name == AUTO_KEY_NAME) {
                let rotated = client
                    .rotate_api_key(project_id, &any_named.id)
                    .await
                    .context("rotate Cloud API key after quota exceeded")?;
                store_api_key(profile_name, &rotated.secret, api_origin, project_id)?;
                return Ok((
                    rotated.secret,
                    ProvisionOutcome::Rotated {
                        key_id: rotated.key.id,
                    },
                ));
            }
            Err(err).context(format!(
                "create Cloud API key '{AUTO_KEY_NAME}' failed (API key quota exceeded).\n\
                 Revoke unused keys in the dashboard, or run: am key list\n\
                 Then re-run init — the CLI will rotate an existing '{AUTO_KEY_NAME}' key when present."
            ))
        }
        Err(err) => Err(err).context(format!(
            "create Cloud API key '{AUTO_KEY_NAME}' on {api_origin}"
        )),
    }
}

async fn probe_cloud_api_key_mint(base_url: &str, api_key: &str) -> Result<(), CloudClientError> {
    let base = Url::parse(base_url)?;
    let client = MemoryClient::new(base, api_key)?;
    client.mint_local_token().await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn key(
        id: &str,
        name: &str,
        status: &str,
        created_secs: i64,
        last_used_secs: Option<i64>,
    ) -> ApiKey {
        ApiKey {
            id: id.into(),
            project_id: "proj_test".into(),
            name: name.into(),
            prefix: "amc_dev_xx".into(),
            status: status.into(),
            created_at: Utc.timestamp_opt(created_secs, 0).unwrap(),
            last_used_at: last_used_secs.map(|s| Utc.timestamp_opt(s, 0).unwrap()),
        }
    }

    #[test]
    fn select_prefers_active_runtime_name() {
        let keys = vec![
            key("k1", "other", "active", 100, Some(200)),
            key("k2", AUTO_KEY_NAME, "revoked", 300, Some(400)),
            key("k3", AUTO_KEY_NAME, "active", 50, Some(10)),
        ];
        let picked = select_runtime_key_for_rotate(&keys).unwrap();
        assert_eq!(picked.id, "k3");
    }

    #[test]
    fn select_prefers_most_recently_used_among_active_runtime_keys() {
        let keys = vec![
            key("old", AUTO_KEY_NAME, "active", 10, Some(20)),
            key("fresh", AUTO_KEY_NAME, "active", 5, Some(99)),
            key("newer_created", AUTO_KEY_NAME, "active", 80, None),
        ];
        let picked = select_runtime_key_for_rotate(&keys).unwrap();
        assert_eq!(picked.id, "fresh");
    }

    #[test]
    fn select_returns_none_when_no_active_runtime_key() {
        let keys = vec![
            key("k1", AUTO_KEY_NAME, "revoked", 1, None),
            key("k2", "connected-traces", "active", 2, None),
        ];
        assert!(select_runtime_key_for_rotate(&keys).is_none());
    }

    #[test]
    fn rotated_message_is_obvious_and_quota_safe() {
        let msg = ProvisionOutcome::Rotated {
            key_id: "key_abc".into(),
        }
        .operator_message()
        .unwrap();
        assert!(msg.contains("Rotated"));
        assert!(msg.contains(AUTO_KEY_NAME));
        assert!(msg.contains("quota-safe"));
        assert!(msg.contains("invalidated"));
        assert!(msg.contains("key_abc"));
    }

    #[test]
    fn created_message_names_the_key() {
        let msg = ProvisionOutcome::Created {
            key_id: "key_new".into(),
        }
        .operator_message()
        .unwrap();
        assert!(msg.contains("Created"));
        assert!(msg.contains(AUTO_KEY_NAME));
        assert!(msg.contains("key_new"));
    }

    #[test]
    fn reused_is_silent_on_stderr() {
        assert!(ProvisionOutcome::Reused.operator_message().is_none());
        assert_eq!(
            ProvisionOutcome::Reused.progress_detail(),
            "reused stored key"
        );
    }

    #[test]
    fn requires_container_sync_only_for_created_and_rotated() {
        assert!(!ProvisionOutcome::Reused.requires_container_sync());
        assert!(ProvisionOutcome::Rotated { key_id: "k".into() }.requires_container_sync());
        assert!(ProvisionOutcome::Created { key_id: "k".into() }.requires_container_sync());
    }

    #[test]
    fn should_rotate_after_probe_only_on_auth() {
        assert!(should_rotate_after_probe(&CloudClientError::Auth));
        assert!(!should_rotate_after_probe(&CloudClientError::Timeout));
        assert!(!should_rotate_after_probe(&CloudClientError::Network(
            "dns".into()
        )));
        assert!(!should_rotate_after_probe(&CloudClientError::Status {
            code: 500,
            body: "error".into()
        }));
    }

    #[test]
    fn quota_exceeded_detector_matches_cloud_body() {
        let err = CloudClientError::Status {
            code: 429,
            body: r#"{"error":{"code":"quota_exceeded","message":"quota exceeded: max_api_keys"}}"#
                .into(),
        };
        assert!(is_api_key_quota_exceeded(&err));
        let other = CloudClientError::Status {
            code: 429,
            body: r#"{"error":{"code":"rate_limited"}}"#.into(),
        };
        assert!(!is_api_key_quota_exceeded(&other));
    }
}
