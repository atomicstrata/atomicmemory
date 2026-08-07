//! Atomic host-config writes with private backups.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde_json::Value;

use crate::config::config_dir;
use crate::integrate::host::MCP_SERVER_NAME;
use crate::integrate::path_util::home_dir;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const BACKUP_RETENTION: usize = 10;
/// Maximum symlink hops to follow before treating the chain as looping/hostile.
const MAX_SYMLINK_DEPTH: usize = 40;

pub fn backup_host_config(path: &Path) -> Result<Option<PathBuf>> {
    let dir = config_dir()?.join("integrate-backups");
    backup_host_config_in(path, &dir, BACKUP_RETENTION)
}

fn backup_host_config_in(path: &Path, dir: &Path, keep: usize) -> Result<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }
    fs::create_dir_all(dir).context("create integrate backup dir")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .context("chmod integrate backup dir")?;
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    let backup = dir.join(format!("{file_name}.{stamp}.bak"));
    fs::copy(path, &backup).with_context(|| format!("backup {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&backup, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("chmod backup {}", backup.display()))?;
    }
    prune_backups(dir, file_name, keep)?;
    Ok(Some(backup))
}

fn prune_backups(dir: &Path, file_name: &str, keep: usize) -> Result<()> {
    let prefix = format!("{file_name}.");
    let mut backups = fs::read_dir(dir)
        .with_context(|| format!("read backup dir {}", dir.display()))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".bak"))
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for stale in backups.into_iter().skip(keep) {
        fs::remove_file(&stale).with_context(|| format!("prune backup {}", stale.display()))?;
    }
    Ok(())
}

fn unique_temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".{file_name}.{nanos}.{id}.tmp"))
}

pub fn restore_host_config(path: &Path, backup: Option<&Path>) -> Result<()> {
    if let Some(backup) = backup {
        fs::copy(backup, path)
            .with_context(|| format!("restore {} from backup", path.display()))?;
        return Ok(());
    }
    if path.exists() {
        fs::remove_file(path).with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

pub fn write_secure_file(path: &Path, contents: &str) -> Result<()> {
    let write_path = resolve_write_target(path)?;
    if let Some(parent) = write_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create dir {}", parent.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                    .context("chmod new parent dir")?;
            }
        }
    }
    let tmp = unique_temp_path(&write_path);
    {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)
                .with_context(|| format!("open temp {}", tmp.display()))?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()
                .with_context(|| format!("sync temp {}", tmp.display()))?;
        }
        #[cfg(not(unix))]
        {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .with_context(|| format!("open temp {}", tmp.display()))?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()
                .with_context(|| format!("sync temp {}", tmp.display()))?;
        }
    }
    fs::rename(&tmp, &write_path).with_context(|| format!("rename {}", write_path.display()))?;
    Ok(())
}

fn resolve_write_target(path: &Path) -> Result<PathBuf> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(path.to_path_buf());
    };
    if !metadata.file_type().is_symlink() {
        return Ok(path.to_path_buf());
    }
    // The config path is a symlink. Follow the terminal chain, then resolve the
    // real parent directory — following any symlinked directory components too —
    // and confine the write to $HOME or the config's own directory. A hostile
    // symlink, including one hidden behind a symlinked parent dir, must not
    // redirect this credential-bearing write outside the user's tree (fail
    // closed). Writing to the real target also means the atomic temp+rename
    // never traverses a symlinked parent.
    let resolved = resolve_symlink_chain(path)?;
    let real_target = real_write_path(&resolved)?;
    guard_write_target(path, &real_target)?;
    Ok(real_target)
}

/// Follow a symlink chain to its final path without requiring the target to
/// exist yet (the file is about to be created). Relative links resolve against
/// the link's own directory.
fn resolve_symlink_chain(path: &Path) -> Result<PathBuf> {
    let mut current = path.to_path_buf();
    for _ in 0..MAX_SYMLINK_DEPTH {
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = fs::read_link(&current)
                    .with_context(|| format!("read symlink {}", current.display()))?;
                current = if target.is_absolute() {
                    target
                } else {
                    current
                        .parent()
                        .unwrap_or_else(|| Path::new("."))
                        .join(target)
                };
            }
            _ => return Ok(current),
        }
    }
    bail!("symlink chain too deep at {}", path.display())
}

/// Resolve `path`'s parent through symlinked directory components and re-attach
/// the file name, so confinement is checked against the true on-disk location
/// rather than a lexical path that a symlinked parent could disguise.
fn real_write_path(path: &Path) -> Result<PathBuf> {
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("write target has no file name: {}", path.display()))?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    Ok(canonicalize_deepest(parent)?.join(file_name))
}

/// Canonicalize the deepest existing ancestor of `dir`, re-appending the
/// components that do not exist yet. A not-yet-created path component cannot be
/// a symlink, so re-appending it lexically is safe.
fn canonicalize_deepest(dir: &Path) -> Result<PathBuf> {
    let mut existing = dir.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = existing.canonicalize() {
            let mut out = real;
            for component in tail.iter().rev() {
                out.push(component);
            }
            return Ok(out);
        }
        let Some(name) = existing.file_name().map(|name| name.to_os_string()) else {
            bail!("cannot resolve real path for {}", dir.display());
        };
        tail.push(name);
        if !existing.pop() {
            bail!("cannot resolve real path for {}", dir.display());
        }
    }
}

/// Refuse to write through a symlink whose real target escapes both the user's
/// home directory and the config's own directory, or points at anything other
/// than a regular file. Roots are canonicalized so a symlinked parent cannot
/// masquerade as an allowed location.
fn guard_write_target(link: &Path, real_target: &Path) -> Result<()> {
    let mut allowed_roots = Vec::new();
    if let Ok(home) = home_dir() {
        if let Ok(real_home) = home.canonicalize() {
            allowed_roots.push(real_home);
        }
    }
    if let Some(parent) = link.parent() {
        if let Ok(real_parent) = canonicalize_deepest(parent) {
            allowed_roots.push(real_parent);
        }
    }
    let within_allowed = allowed_roots
        .iter()
        .any(|root| real_target.starts_with(root));
    if !within_allowed {
        bail!(
            "refusing to write {}: symlink resolves to {} outside the home directory",
            link.display(),
            real_target.display()
        );
    }
    if let Ok(meta) = fs::symlink_metadata(real_target) {
        if !meta.file_type().is_file() {
            bail!(
                "refusing to write {}: symlink target {} is not a regular file",
                link.display(),
                real_target.display()
            );
        }
    }
    Ok(())
}

pub fn read_json_file(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(Value::Object(Default::default()));
    }
    let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    let value: Value =
        serde_json::from_str(&raw).with_context(|| format!("parse JSON {}", path.display()))?;
    if !value.is_object() {
        bail!(
            "{} root must be a JSON object — refusing to overwrite",
            path.display()
        );
    }
    Ok(value)
}

pub fn current_json_entry(existing: &Value) -> Option<Value> {
    existing
        .get("mcpServers")
        .and_then(|s| s.get(MCP_SERVER_NAME))
        .cloned()
}

pub fn merge_json_mcp(
    existing: &Value,
    server_entry: &Value,
    force: bool,
) -> Result<(Value, bool)> {
    let current = current_json_entry(existing);
    if let Some(current) = &current {
        if current == server_entry {
            return Ok((existing.clone(), false));
        }
        if !force {
            bail!("existing `{MCP_SERVER_NAME}` entry differs — pass --force to overwrite");
        }
    }
    let mut root = existing.clone();
    let obj = root
        .as_object_mut()
        .context("host config root must be a JSON object")?;
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Default::default()));
    let map = servers
        .as_object_mut()
        .context("mcpServers must be a JSON object")?;
    map.insert(MCP_SERVER_NAME.to_string(), server_entry.clone());
    Ok((root, true))
}

pub fn remove_or_restore_json_mcp(
    existing: &Value,
    restore_entry: Option<&str>,
) -> Result<(Value, bool)> {
    let mut root = existing.clone();
    let (changed, remove_empty_servers) = {
        let Some(obj) = root.as_object_mut() else {
            return Ok((root, false));
        };
        let Some(servers) = obj.get_mut("mcpServers") else {
            return Ok((root, false));
        };
        let Some(map) = servers.as_object_mut() else {
            return Ok((root, false));
        };
        if let Some(raw) = restore_entry {
            let entry: Value = serde_json::from_str(raw).context("parse stored prior MCP entry")?;
            map.insert(MCP_SERVER_NAME.to_string(), entry);
            (true, false)
        } else {
            let changed = map.remove(MCP_SERVER_NAME).is_some();
            (changed, changed && map.is_empty())
        }
    };
    if remove_empty_servers {
        if let Some(obj) = root.as_object_mut() {
            obj.remove("mcpServers");
        }
    }
    Ok((root, changed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_refuses_conflicting_entry_without_force() {
        let existing = json!({ "mcpServers": { "atomicmemory": { "command": "old" } } });
        let entry = json!({ "command": "npx" });
        assert!(merge_json_mcp(&existing, &entry, false).is_err());
    }

    #[test]
    fn rejects_non_object_json_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(&path, "[]").unwrap();
        assert!(read_json_file(&path).is_err());
    }

    #[test]
    fn atomic_write_uses_unique_temp_and_rename() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        write_secure_file(&path, "{}\n").unwrap();
        assert!(path.exists());
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|entry| {
                entry
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.contains(".tmp"))
            })
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn secure_write_preserves_symlink_and_updates_target() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.json");
        let link = dir.path().join("mcp.json");
        fs::write(&target, "{}\n").unwrap();
        symlink(&target, &link).unwrap();

        write_secure_file(&link, "{\"ok\":true}\n").unwrap();

        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"ok\":true}\n");
    }

    #[cfg(unix)]
    #[test]
    fn secure_write_rejects_symlink_escaping_home_and_config_dir() {
        use std::os::unix::fs::symlink;

        // A config symlink that points outside both $HOME and its own directory
        // must not redirect the write (it would clobber an unrelated file and
        // leak credentials into it).
        let config_dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let escape_target = outside_dir.path().join("victim.txt");
        fs::write(&escape_target, "original\n").unwrap();
        let link = config_dir.path().join("mcp.json");
        symlink(&escape_target, &link).unwrap();

        let err = write_secure_file(&link, "{\"leak\":true}\n").unwrap_err();
        assert!(err.to_string().contains("refusing to write"));
        assert_eq!(fs::read_to_string(&escape_target).unwrap(), "original\n");
    }

    #[cfg(unix)]
    #[test]
    fn secure_write_rejects_symlinked_parent_escape() {
        use std::os::unix::fs::symlink;

        // A symlinked *parent directory* must not smuggle the write outside the
        // allowed roots: config/mcp.json -> config/jump/victim, where
        // config/jump is itself a symlink to an outside directory.
        let config_dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let jump = config_dir.path().join("jump");
        symlink(outside_dir.path(), &jump).unwrap();
        let victim = outside_dir.path().join("victim.txt");
        fs::write(&victim, "original\n").unwrap();
        let link = config_dir.path().join("mcp.json");
        symlink(jump.join("victim.txt"), &link).unwrap();

        let err = write_secure_file(&link, "{\"leak\":true}\n").unwrap_err();
        assert!(err.to_string().contains("refusing to write"));
        assert_eq!(fs::read_to_string(&victim).unwrap(), "original\n");
    }

    #[cfg(unix)]
    #[test]
    fn backup_copy_is_private_and_prunes_old_backups() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("mcp.json");
        let backup_dir = dir.path().join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        fs::write(&source, "{\"secret\":\"new\"}\n").unwrap();
        for idx in 0..5 {
            fs::write(
                backup_dir.join(format!("mcp.json.{idx:020}.bak")),
                format!("old {idx}\n"),
            )
            .unwrap();
        }

        let backup = backup_host_config_in(&source, &backup_dir, 3)
            .unwrap()
            .unwrap();

        let mode = fs::metadata(&backup).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let backups: Vec<_> = fs::read_dir(&backup_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
            .collect();
        assert!(
            backups.len() <= 3,
            "expected at most 3 backups, got {}",
            backups.len()
        );
    }

    #[test]
    fn restore_host_config_reverts_from_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let backup = dir.path().join("mcp.json.bak");
        fs::write(&backup, r#"{"mcpServers": {}}"#).unwrap();
        fs::write(&path, r#"{"changed": true}"#).unwrap();
        restore_host_config(&path, Some(&backup)).unwrap();
        let restored = fs::read_to_string(&path).unwrap();
        assert!(restored.contains("mcpServers"));
    }

    #[test]
    fn remove_without_restore_drops_empty_mcp_servers_object() {
        let existing = json!({ "mcpServers": { "atomicmemory": { "command": "npx" } } });
        let (merged, changed) = remove_or_restore_json_mcp(&existing, None).unwrap();
        assert!(changed);
        assert!(merged.get("mcpServers").is_none());
    }
}
