//! Release artifact names for the platforms `install.sh` publishes.

use anyhow::{Result, bail};

/// Rust target triple for this process, or an error on an unpublished platform.
pub fn current_target() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        (os, arch) => {
            bail!("unsupported platform {os}-{arch} (supported: Linux and macOS, x86_64 and arm64)")
        }
    }
}

/// Tarball file name: `am-{version}-{target}.tar.gz`.
pub fn artifact_name(version: &str, target: &str) -> String {
    format!("am-{version}-{target}.tar.gz")
}

/// Directory URL that holds one published CLI version.
pub fn release_prefix(base: &str, version: &str) -> String {
    format!("{}/cli/v{version}", base.trim_end_matches('/'))
}

/// Absolute URL of the platform tarball.
pub fn artifact_url(base: &str, version: &str, target: &str) -> String {
    format!(
        "{}/{}",
        release_prefix(base, version),
        artifact_name(version, target)
    )
}

/// Absolute URL of the checksum manifest beside the tarball.
pub fn sums_url(base: &str, version: &str) -> String {
    format!("{}/SHA256SUMS", release_prefix(base, version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_urls_match_the_install_mirror_layout() {
        let base = "https://get.atomicstrata.ai";
        assert_eq!(
            artifact_url(base, "0.2.0", "aarch64-apple-darwin"),
            "https://get.atomicstrata.ai/cli/v0.2.0/am-0.2.0-aarch64-apple-darwin.tar.gz"
        );
        assert_eq!(
            sums_url(base, "0.2.0"),
            "https://get.atomicstrata.ai/cli/v0.2.0/SHA256SUMS"
        );
    }

    #[test]
    fn current_target_matches_the_build_platform() {
        let expected = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Some("aarch64-apple-darwin")
        } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
            Some("x86_64-apple-darwin")
        } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
            Some("aarch64-unknown-linux-gnu")
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Some("x86_64-unknown-linux-gnu")
        } else {
            None
        };
        match expected {
            Some(triple) => assert_eq!(current_target().expect("published target"), triple),
            None => {
                let err = current_target().expect_err("unpublished platform");
                assert!(err.to_string().contains("unsupported platform"), "{err}");
            }
        }
    }
}
