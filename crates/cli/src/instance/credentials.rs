//! Resolve a Core credential only from the selected provider's state volume.

use super::docker::{DockerRunner, InstanceConfig};
use anyhow::{Result, bail};

/// Preserve the selected dataset's bearer unless an explicit replacement or reset was requested.
pub async fn resolve_dataset_key(
    docker: &dyn DockerRunner,
    config: &InstanceConfig,
    reset: bool,
    explicit: Option<String>,
    replace: bool,
) -> Result<String> {
    let saved = docker
        .read_volume_core_api_key(&config.storage.state, &config.image)
        .await?;
    select_key(saved, reset, explicit, replace)
}

fn select_key(
    saved: Option<String>,
    reset: bool,
    explicit: Option<String>,
    replace: bool,
) -> Result<String> {
    if let (Some(saved), Some(explicit)) = (&saved, &explicit)
        && saved != explicit
        && !replace
    {
        bail!(
            "CORE_API_KEY differs from the selected dataset's persisted key; use --replace to authorize updating it"
        );
    }
    Ok(explicit
        .or(if reset { None } else { saved })
        .unwrap_or_else(super::generate_core_api_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_reused_until_an_explicit_reset() {
        let saved = Some("provider-secret".into());
        assert_eq!(
            select_key(saved.clone(), false, None, false).unwrap(),
            "provider-secret"
        );
        let reset = select_key(saved, true, None, false).unwrap();
        assert_eq!(reset.len(), 64);
        assert_ne!(reset, "provider-secret");
    }

    #[test]
    fn conflicting_override_requires_explicit_replacement() {
        assert!(select_key(Some("saved".into()), false, Some("new".into()), false).is_err());
        assert_eq!(
            select_key(Some("saved".into()), false, Some("new".into()), true).unwrap(),
            "new"
        );
    }
}
