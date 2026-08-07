//! PATH and home-directory helpers for host integration.

use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

pub fn home_dir() -> Result<PathBuf> {
    directories::UserDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .ok_or_else(|| anyhow::anyhow!("cannot resolve home directory for global host config"))
}

pub fn canonical_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    env::current_dir()
        .context("resolve current directory")?
        .join(path)
        .canonicalize()
        .or_else(|_| Ok(env::current_dir()?.join(path)))
}

pub fn candidate_executables(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let mut candidates = vec![name.to_string()];
        if !name.contains('.') {
            for ext in windows_pathext() {
                candidates.push(format!("{name}.{ext}"));
            }
        }
        candidates
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

pub fn binary_on_path(name: &str) -> bool {
    let path_var = env::var_os("PATH").unwrap_or_default();
    for dir in env::split_paths(&path_var) {
        if executable_exists_in_dir(&dir, name) {
            return true;
        }
    }
    false
}

pub(crate) fn executable_exists_in_dir(dir: &Path, name: &str) -> bool {
    candidate_executables(name)
        .into_iter()
        .any(|candidate| executable_exists(&dir.join(candidate)))
}

fn executable_exists(path: &Path) -> bool {
    path.is_file()
}

#[cfg(windows)]
fn windows_pathext() -> Vec<String> {
    env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC".into())
        .split(';')
        .filter_map(|ext| {
            let ext = ext.trim();
            if ext.is_empty() {
                None
            } else {
                Some(ext.trim_start_matches('.').to_ascii_lowercase())
            }
        })
        .collect()
}

pub fn require_npx() -> Result<()> {
    if binary_on_path("npx") {
        return Ok(());
    }
    bail!("npx not found on PATH — install Node.js 20+ from https://nodejs.org and retry")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn unknown_binary_is_not_on_path() {
        assert!(!binary_on_path("am-integrate-fixture-missing-binary"));
    }

    #[test]
    fn executable_exists_for_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("fixture-host");
        fs::write(&bin, b"").unwrap();
        assert!(executable_exists(&bin));
    }

    #[test]
    fn candidate_executables_includes_pathext_suffixes_on_windows() {
        #[cfg(windows)]
        {
            let names = candidate_executables("npx");
            assert!(
                names
                    .iter()
                    .any(|name| name.eq_ignore_ascii_case("npx.cmd"))
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(candidate_executables("npx"), vec!["npx".to_string()]);
        }
    }

    #[test]
    fn finds_pathext_executable_in_directory() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        fs::write(dir.path().join("npx.cmd"), b"").unwrap();
        #[cfg(not(windows))]
        fs::write(dir.path().join("npx"), b"").unwrap();
        assert!(executable_exists_in_dir(dir.path(), "npx"));
    }
}
