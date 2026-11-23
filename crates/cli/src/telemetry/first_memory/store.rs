//! Privacy state is independent of profile/auth configuration. Even an invalid
//! opted-out command must revoke pending delivery without rewriting config.toml.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;

#[derive(Default, Serialize, Deserialize)]
pub(super) struct DeliveryState {
    pub telemetry_distinct_id: Option<String>,
    pub telemetry_first_real_memory_sent: Option<bool>,
    pub telemetry_first_memory: Option<super::FirstMemoryState>,
    pub telemetry_consent_generation: Option<String>,
    pub scope_salt: Option<String>,
}

pub(super) struct Store {
    path: PathBuf,
    legacy: Option<PathBuf>,
}

impl Store {
    pub fn production() -> Result<Self> {
        Ok(Self {
            path: crate::config::config_dir()?.join("telemetry-first-memory.toml"),
            legacy: Some(crate::config::config_path()?),
        })
    }

    #[cfg(test)]
    pub fn at(path: PathBuf) -> Self {
        Self { path, legacy: None }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<DeliveryState> {
        if self.path.exists() {
            return toml::from_str(&std::fs::read_to_string(&self.path)?)
                .context("parse telemetry delivery state");
        }
        // Only import the old install identifier and terminal sent marker.
        // Never copy profiles, OAuth data or credentials into this store.
        let Some(path) = self.legacy.as_ref().filter(|path| path.exists()) else {
            return Ok(DeliveryState::default());
        };
        let old: crate::config::ConfigFile = toml::from_str(&std::fs::read_to_string(path)?)?;
        Ok(DeliveryState {
            telemetry_distinct_id: old.telemetry_distinct_id,
            telemetry_first_real_memory_sent: old.telemetry_first_real_memory_sent,
            ..Default::default()
        })
    }

    pub fn update<T>(&self, mutate: impl FnOnce(&mut DeliveryState) -> Result<T>) -> Result<T> {
        crate::config::with_path_lock(&self.path, || {
            let mut state = self.load()?;
            let out = mutate(&mut state)?;
            crate::config::write_atomic_file(&self.path, &toml::to_string_pretty(&state)?, 0o600)?;
            Ok(out)
        })
    }
}

pub(super) fn update_state<T>(mutate: impl FnOnce(&mut DeliveryState) -> Result<T>) -> Result<T> {
    Store::production()?.update(mutate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_only_legacy_telemetry_without_rewriting_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("config.toml");
        let original = "# preserve formatting\ntelemetry_distinct_id = 'cli_legacy'\ntelemetry_first_real_memory_sent = true\n";
        std::fs::write(&legacy, original).unwrap();
        let store = Store {
            path: dir.path().join("telemetry-first-memory.toml"),
            legacy: Some(legacy.clone()),
        };
        store
            .update(|state| {
                assert_eq!(state.telemetry_distinct_id.as_deref(), Some("cli_legacy"));
                assert_eq!(state.telemetry_first_real_memory_sent, Some(true));
                state.telemetry_consent_generation = Some("revoked".into());
                Ok(())
            })
            .unwrap();
        assert_eq!(std::fs::read_to_string(legacy).unwrap(), original);
        let restored = store.load().unwrap();
        assert_eq!(
            restored.telemetry_consent_generation.as_deref(),
            Some("revoked")
        );
        assert_eq!(restored.telemetry_first_real_memory_sent, Some(true));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(store.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
