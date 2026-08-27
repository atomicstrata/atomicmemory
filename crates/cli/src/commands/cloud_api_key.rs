//! Per-installation Cloud API key provisioning for Connected Local.
//!
//! A working locally stored `amc_` key is reused. Replacement may rotate only
//! this installation's exact managed name, so another machine's credential is
//! never invalidated automatically.

use am_cloud_client::{CloudClientError, DashboardClient, MemoryClient};
use am_cloud_types::{ApiKey, ApiKeyWithSecret, CreateApiKeyRequest};
use anyhow::{Context, Result, bail};
use tracing::info;
use url::Url;

use crate::auth::origin::same_origin;
use crate::cli::GlobalOptions;
use crate::commands::client::{cloud_api_key_client, dashboard_client};
use crate::config::{
    ResolvedProfile, is_cloud_api_key, machine_scoped_key_name, require_api_key,
    require_project_id, store_api_key,
};
use crate::instance::AUTO_KEY_NAME;
use crate::output::message;

#[async_trait::async_trait]
trait ConnectedLocalCredentialBackend: Send + Sync {
    async fn list_api_keys(&self, project_id: &str) -> Result<Vec<ApiKey>, CloudClientError>;

    async fn rotate_api_key(
        &self,
        project_id: &str,
        key_id: &str,
    ) -> Result<ApiKeyWithSecret, CloudClientError>;

    async fn create_api_key(
        &self,
        project_id: &str,
        request: &CreateApiKeyRequest,
    ) -> Result<ApiKeyWithSecret, CloudClientError>;
}

#[async_trait::async_trait]
impl ConnectedLocalCredentialBackend for DashboardClient {
    async fn list_api_keys(&self, project_id: &str) -> Result<Vec<ApiKey>, CloudClientError> {
        DashboardClient::list_api_keys(self, project_id).await
    }

    async fn rotate_api_key(
        &self,
        project_id: &str,
        key_id: &str,
    ) -> Result<ApiKeyWithSecret, CloudClientError> {
        DashboardClient::rotate_api_key(self, project_id, key_id).await
    }

    async fn create_api_key(
        &self,
        project_id: &str,
        request: &CreateApiKeyRequest,
    ) -> Result<ApiKeyWithSecret, CloudClientError> {
        DashboardClient::create_api_key(self, project_id, request).await
    }
}

/// How a Connected Local Cloud API key was obtained for this run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvisionOutcome {
    /// Locally stored `amc_` key still mints against this Cloud origin.
    Reused,
    /// Rotated this installation's existing managed key.
    Rotated { key_id: String, key_name: String },
    /// Created this installation's managed key.
    Created { key_id: String, key_name: String },
}

impl ProvisionOutcome {
    /// Short progress-step detail (wizard / init).
    pub fn progress_detail(&self) -> &'static str {
        match self {
            Self::Reused => "reused stored key",
            Self::Rotated { .. } => "rotated per-installation key",
            Self::Created { .. } => "created per-installation key",
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
            Self::Rotated { key_id, key_name } => Some(format!(
                "Rotated this installation's Cloud API key '{key_name}' ({key_id}); \
                 previous secret is invalidated and the new secret is saved locally (not printed)."
            )),
            Self::Created { key_id, key_name } => Some(format!(
                "Created this installation's Cloud API key '{key_name}' ({key_id}) and saved locally (not printed)."
            )),
        }
    }
}

/// Pick this installation's active Connected Local key to rotate.
///
/// Prefers the most recently used exact-name match, then newest `created_at`.
/// Legacy and other installations' names are excluded.
pub fn select_runtime_key_for_rotate<'a>(keys: &'a [ApiKey], key_name: &str) -> Option<&'a ApiKey> {
    select_named_key_for_rotate(keys, key_name)
}

/// Pick the active exact-name key that is safest to rotate.
///
/// Prefers the most recently used key, then the newest key.
pub(crate) fn select_named_key_for_rotate<'a>(
    keys: &'a [ApiKey],
    name: &str,
) -> Option<&'a ApiKey> {
    let mut candidates: Vec<&ApiKey> = keys
        .iter()
        .filter(|k| k.name == name && status_is_active(&k.status))
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

pub(crate) fn is_api_key_quota_exceeded(err: &CloudClientError) -> bool {
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

    let key_name = machine_scoped_key_name(AUTO_KEY_NAME)?;
    let (secret, outcome) = rotate_or_create_runtime_key(
        &client,
        &project_id,
        &key_name,
        &profile.base_url,
        |secret| store_api_key(&profile.name, secret, &profile.base_url, &project_id),
    )
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
    let key_name = machine_scoped_key_name(AUTO_KEY_NAME)?;
    let (_secret, outcome) = rotate_or_create_runtime_key(
        &client,
        project_id,
        &key_name,
        &profile.base_url,
        |secret| store_api_key(profile_name, secret, &profile.base_url, project_id),
    )
    .await?;
    if let Some(msg) = outcome.operator_message() {
        message(!global.quiet, &msg);
    }
    Ok(outcome)
}

async fn rotate_or_create_runtime_key<F>(
    client: &dyn ConnectedLocalCredentialBackend,
    project_id: &str,
    key_name: &str,
    api_origin: &str,
    store: F,
) -> Result<(String, ProvisionOutcome)>
where
    F: Fn(&str) -> Result<()>,
{
    let keys = client
        .list_api_keys(project_id)
        .await
        .context("list Cloud API keys")?;

    if let Some(existing) = select_runtime_key_for_rotate(&keys, key_name) {
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
        store(&rotated.secret)?;
        return Ok((
            rotated.secret,
            ProvisionOutcome::Rotated {
                key_id: rotated.key.id,
                key_name: key_name.to_string(),
            },
        ));
    }

    info!(name = key_name, "creating Connected Local Cloud API key");
    match client
        .create_api_key(
            project_id,
            &CreateApiKeyRequest {
                name: key_name.to_string(),
                environment: None,
            },
        )
        .await
    {
        Ok(created) => {
            store(&created.secret)?;
            Ok((
                created.secret,
                ProvisionOutcome::Created {
                    key_id: created.key.id,
                    key_name: key_name.to_string(),
                },
            ))
        }
        Err(err) if is_api_key_quota_exceeded(&err) => {
            // Race: list saw no active exact-name key but quota is full. A revoked
            // key owned by this installation remains safe to rotate; every other
            // name is outside this installation's authority.
            if let Some(any_named) = keys.iter().find(|k| k.name == key_name) {
                let rotated = client
                    .rotate_api_key(project_id, &any_named.id)
                    .await
                    .context("rotate Cloud API key after quota exceeded")?;
                store(&rotated.secret)?;
                return Ok((
                    rotated.secret,
                    ProvisionOutcome::Rotated {
                        key_id: rotated.key.id,
                        key_name: key_name.to_string(),
                    },
                ));
            }
            Err(err).context(format!(
                "create Cloud API key '{key_name}' failed (API key quota exceeded).\n\
                 Revoke unused keys in the dashboard, or run: am key list\n\
                 Then re-run init — the CLI will rotate only this installation's '{key_name}' key when present."
            ))
        }
        Err(err) => Err(err).context(format!("create Cloud API key '{key_name}' on {api_origin}")),
    }
}

async fn probe_cloud_api_key_mint(base_url: &str, api_key: &str) -> Result<(), CloudClientError> {
    let base = Url::parse(base_url)?;
    let client = MemoryClient::new(base, api_key)?;
    client.mint_local_token().await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;
    use am_cloud_types::ApiKeyWithSecret;
    use chrono::{TimeZone, Utc};

    const TEST_LOCAL_KEY_NAME: &str = "connected-local-runtime-a1b2c3d4e5f6";

    struct FakeConnectedLocalBackend {
        lists: Mutex<VecDeque<Result<Vec<ApiKey>, CloudClientError>>>,
        rotates: Mutex<VecDeque<Result<ApiKeyWithSecret, CloudClientError>>>,
        rotate_calls: Mutex<Vec<(String, String)>>,
        creates: Mutex<VecDeque<Result<ApiKeyWithSecret, CloudClientError>>>,
        create_names: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl ConnectedLocalCredentialBackend for FakeConnectedLocalBackend {
        async fn list_api_keys(&self, _project_id: &str) -> Result<Vec<ApiKey>, CloudClientError> {
            self.lists
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        }

        async fn rotate_api_key(
            &self,
            project_id: &str,
            key_id: &str,
        ) -> Result<ApiKeyWithSecret, CloudClientError> {
            self.rotate_calls
                .lock()
                .unwrap()
                .push((project_id.to_string(), key_id.to_string()));
            self.rotates
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| panic!("missing rotate response"))
        }

        async fn create_api_key(
            &self,
            _project_id: &str,
            request: &CreateApiKeyRequest,
        ) -> Result<ApiKeyWithSecret, CloudClientError> {
            self.create_names.lock().unwrap().push(request.name.clone());
            self.creates
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| panic!("missing create response"))
        }
    }

    fn backend(
        keys: Vec<ApiKey>,
        create: Result<ApiKeyWithSecret, CloudClientError>,
        rotates: Vec<Result<ApiKeyWithSecret, CloudClientError>>,
    ) -> FakeConnectedLocalBackend {
        FakeConnectedLocalBackend {
            lists: Mutex::new([Ok(keys)].into()),
            rotates: Mutex::new(rotates.into()),
            rotate_calls: Mutex::new(Vec::new()),
            creates: Mutex::new([create].into()),
            create_names: Mutex::new(Vec::new()),
        }
    }

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

    fn key_with_secret(key: ApiKey, secret: &str) -> ApiKeyWithSecret {
        ApiKeyWithSecret {
            key,
            secret: secret.into(),
        }
    }

    #[test]
    fn select_matches_only_this_installations_active_runtime_name() {
        let keys = vec![
            key(
                "legacy",
                "connected-local-runtime",
                "active",
                100,
                Some(200),
            ),
            key(
                "foreign",
                "connected-local-runtime-ffffffffffff",
                "active",
                300,
                Some(400),
            ),
            key("own", TEST_LOCAL_KEY_NAME, "active", 50, Some(10)),
        ];
        let picked = select_runtime_key_for_rotate(&keys, TEST_LOCAL_KEY_NAME).unwrap();
        assert_eq!(picked.id, "own");
    }

    #[test]
    fn select_prefers_most_recently_used_among_active_runtime_keys() {
        let keys = vec![
            key("old", TEST_LOCAL_KEY_NAME, "active", 10, Some(20)),
            key("fresh", TEST_LOCAL_KEY_NAME, "active", 5, Some(99)),
            key("newer_created", TEST_LOCAL_KEY_NAME, "active", 80, None),
        ];
        let picked = select_runtime_key_for_rotate(&keys, TEST_LOCAL_KEY_NAME).unwrap();
        assert_eq!(picked.id, "fresh");
    }

    #[test]
    fn select_returns_none_for_legacy_and_foreign_installation_names() {
        let keys = vec![
            key("legacy", "connected-local-runtime", "active", 1, None),
            key(
                "foreign",
                "connected-local-runtime-ffffffffffff",
                "active",
                2,
                None,
            ),
        ];
        assert!(select_runtime_key_for_rotate(&keys, TEST_LOCAL_KEY_NAME).is_none());
    }

    #[tokio::test]
    async fn quota_never_rotates_legacy_or_foreign_installation_keys() {
        let client = backend(
            vec![
                key("legacy", "connected-local-runtime", "active", 1, None),
                key(
                    "foreign",
                    "connected-local-runtime-ffffffffffff",
                    "active",
                    2,
                    None,
                ),
            ],
            Err(CloudClientError::Status {
                code: 429,
                body: "quota_exceeded: max_api_keys".into(),
            }),
            Vec::new(),
        );

        let error = rotate_or_create_runtime_key(
            &client,
            "proj_test",
            TEST_LOCAL_KEY_NAME,
            "https://api.atomicstrata.ai",
            |_| -> Result<()> { panic!("quota must not store a credential") },
        )
        .await
        .expect_err("foreign keys must not be quota recovery candidates");

        assert!(error.to_string().contains("quota exceeded"));
        assert!(client.rotate_calls.lock().unwrap().is_empty());
        assert_eq!(
            client.create_names.lock().unwrap().as_slice(),
            [TEST_LOCAL_KEY_NAME]
        );
    }

    #[tokio::test]
    async fn quota_rotates_only_a_non_active_exact_installation_key() {
        let rotated = key_with_secret(
            key("own", TEST_LOCAL_KEY_NAME, "active", 1, None),
            "amc_rotated_secret",
        );
        let client = backend(
            vec![key("own", TEST_LOCAL_KEY_NAME, "revoked", 1, None)],
            Err(CloudClientError::Status {
                code: 429,
                body: "quota_exceeded: max_api_keys".into(),
            }),
            vec![Ok(rotated)],
        );
        let stored = Mutex::new(Vec::new());

        let (_, outcome) = rotate_or_create_runtime_key(
            &client,
            "proj_test",
            TEST_LOCAL_KEY_NAME,
            "https://api.atomicstrata.ai",
            |secret| {
                stored.lock().unwrap().push(secret.to_string());
                Ok(())
            },
        )
        .await
        .expect("the exact installation key is safe to rotate");

        assert_eq!(
            outcome,
            ProvisionOutcome::Rotated {
                key_id: "own".into(),
                key_name: TEST_LOCAL_KEY_NAME.into(),
            }
        );
        assert_eq!(
            client.rotate_calls.lock().unwrap().as_slice(),
            [("proj_test".into(), "own".into())]
        );
        assert_eq!(stored.lock().unwrap().as_slice(), ["amc_rotated_secret"]);
    }

    #[test]
    fn rotated_message_names_this_installations_key() {
        let msg = ProvisionOutcome::Rotated {
            key_id: "key_abc".into(),
            key_name: TEST_LOCAL_KEY_NAME.into(),
        }
        .operator_message()
        .unwrap();
        assert!(msg.contains("Rotated"));
        assert!(msg.contains(TEST_LOCAL_KEY_NAME));
        assert!(!msg.contains("quota-safe"));
        assert!(msg.contains("invalidated"));
        assert!(msg.contains("key_abc"));
    }

    #[test]
    fn created_message_names_the_key() {
        let msg = ProvisionOutcome::Created {
            key_id: "key_new".into(),
            key_name: TEST_LOCAL_KEY_NAME.into(),
        }
        .operator_message()
        .unwrap();
        assert!(msg.contains("Created"));
        assert!(msg.contains(TEST_LOCAL_KEY_NAME));
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
        assert!(
            ProvisionOutcome::Rotated {
                key_id: "k".into(),
                key_name: TEST_LOCAL_KEY_NAME.into(),
            }
            .requires_container_sync()
        );
        assert!(
            ProvisionOutcome::Created {
                key_id: "k".into(),
                key_name: TEST_LOCAL_KEY_NAME.into(),
            }
            .requires_container_sync()
        );
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
