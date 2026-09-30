//! Private staging paths for `am update`.
//!
//! A predictable directory under a shared temp dir can be planted by another
//! local user. `mkdir` must fail if the name exists, the directory stays mode
//! 0700, and artifact writes use `O_CREAT|O_EXCL` so a symlink is not followed.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result, bail};
use rand::Rng;

/// Unpredictable token for staging names. Not a secret, just unguessable.
pub fn random_token() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Create `path` as a new directory. Fails if any entry already exists there.
pub fn create_private_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .with_context(|| format!("create private update dir {}", path.display()))?;
    tighten_private_dir(path)
}

/// Write `bytes` to a new file. An existing path, including a symlink, is an error.
pub fn write_exclusive(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("write {}", path.display()))
}

fn tighten_private_dir(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).with_context(|| format!("stat {}", path.display()))?;
    if !meta.file_type().is_dir() {
        bail!("update staging path is not a private directory");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("chmod 0700 {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_dir_refuses_a_precreated_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("stage");
        fs::create_dir(&path).expect("precreate");
        assert!(create_private_dir(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn exclusive_write_does_not_follow_a_planted_symlink() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().expect("tempdir");
        let marker = tmp.path().join("marker");
        fs::write(&marker, b"keep").expect("marker");
        let link = tmp.path().join("tarball");
        symlink(&marker, &link).expect("symlink");
        assert!(write_exclusive(&link, b"payload").is_err());
        assert_eq!(fs::read(&marker).expect("read"), b"keep");
    }
}
