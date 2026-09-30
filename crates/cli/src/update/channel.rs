//! Which build channels are allowed to replace themselves.
//!
//! Internal and canary binaries are published through a private GitHub release,
//! not the public mirror. A dev build is a source install. Sending either at
//! `get.atomicstrata.ai` would replace it with a different channel's binary.

use anyhow::{Result, bail};

/// Build env stamped on public release binaries.
pub const PRODUCTION_BUILD_ENV: &str = "production";

/// One-line reinstall used when this process cannot write its install directory.
pub const PUBLIC_INSTALL_COMMAND: &str =
    "curl --proto '=https' --tlsv1.2 -fsSL https://get.atomicstrata.ai/install.sh | sh";

const DEV_REFUSAL: &str = "\
am update only replaces production installs from https://get.atomicstrata.ai. \
This binary is a dev build. Reinstall from source with: cargo install --path crates/cli --force";

/// Public binary refusal for internal/canary channels (no private repo slug).
#[cfg(not(feature = "internal-release"))]
const PUBLIC_INTERNAL_REFUSAL: &str = "\
am update only replaces production installs from https://get.atomicstrata.ai. \
This binary is an internal or canary channel build. Reinstall from your internal \
channel (see scripts/install-cli-internal.sh)";

/// Fail closed unless `env` is the public production channel.
pub fn ensure_production_channel(env: &str) -> Result<()> {
    if env == PRODUCTION_BUILD_ENV {
        return Ok(());
    }
    bail!("{}", refusal_message(env))
}

fn refusal_message(env: &str) -> String {
    match env {
        "dev" => DEV_REFUSAL.to_string(),
        "internal" => internal_channel_refusal("cli-internal-latest"),
        "canary" => internal_channel_refusal("cli-canary-latest"),
        other => format!(
            "am update only replaces production installs from https://get.atomicstrata.ai (this binary's build env is {other})"
        ),
    }
}

fn internal_channel_refusal(tag: &str) -> String {
    #[cfg(feature = "internal-release")]
    {
        format!(
            "am update only replaces production installs from https://get.atomicstrata.ai. \
This binary is the {tag} channel. Reinstall with GitHub CLI: \
gh release download {tag} --repo atomicstrata/atomicmemory-internal --pattern install.sh"
        )
    }
    #[cfg(not(feature = "internal-release"))]
    {
        let _ = tag;
        PUBLIC_INTERNAL_REFUSAL.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_is_the_only_channel_that_may_replace_itself() {
        assert!(ensure_production_channel("production").is_ok());
        let dev = ensure_production_channel("dev").unwrap_err().to_string();
        assert!(dev.contains("cargo install --path crates/cli --force"));
        let internal = ensure_production_channel("internal")
            .unwrap_err()
            .to_string();
        let canary = ensure_production_channel("canary").unwrap_err().to_string();
        assert!(!internal.is_empty());
        assert!(!canary.is_empty());
    }

    #[cfg(not(feature = "internal-release"))]
    #[test]
    fn public_build_refuses_with_readme_install_script_and_omits_private_repo() {
        for env in ["internal", "canary"] {
            let msg = ensure_production_channel(env).unwrap_err().to_string();
            assert!(
                msg.contains("scripts/install-cli-internal.sh"),
                "refusal must match README for {env}: {msg}"
            );
            assert!(
                !msg.contains("atomicstrata/atomicmemory-internal"),
                "public binary must not name the private repo for {env}: {msg}"
            );
        }
        assert!(!PUBLIC_INTERNAL_REFUSAL.contains("atomicstrata/atomicmemory-internal"));
    }

    #[cfg(feature = "internal-release")]
    #[test]
    fn internal_release_build_names_the_private_repo() {
        let internal = ensure_production_channel("internal")
            .unwrap_err()
            .to_string();
        assert!(internal.contains("cli-internal-latest"));
        assert!(internal.contains("atomicstrata/atomicmemory-internal"));
        let canary = ensure_production_channel("canary").unwrap_err().to_string();
        assert!(canary.contains("cli-canary-latest"));
        assert!(canary.contains("atomicstrata/atomicmemory-internal"));
    }
}
