//! Managed filesystem layout for the CLI-owned `am-slm` runtime.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

/// On-disk state written by install/start/stop.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SlmStateFile {
    pub installed_version: Option<String>,
    pub installed_tag: Option<String>,
    pub source_sha: Option<String>,
    pub artifact_sha256: Option<String>,
    /// True when the CLI owns the process (pidfile + stop/uninstall).
    pub managed_process: bool,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    /// Start stamp (`ps lstart`) for the managed PID — detects PID reuse.
    #[serde(default)]
    pub process_start_stamp: Option<String>,
    pub binary_path: Option<String>,
    pub log_path: Option<String>,
    /// Embedding dimensionality last used for Connected Local SLM Core volumes.
    pub embedding_dimensions: Option<u32>,
    /// True when managed `am-slm serve` was started with Connected Local
    /// full-extract JSON-schema host flag (`AM_SLM_CORE_JSON_SCHEMA=1`).
    /// Missing/false means a pre-contract process that `--slm` /
    /// `am slm start` should restart. Compact schema is deferred until the
    /// published Core image honors `EXTRACTION_PROMPT_VARIANT`.
    #[serde(default)]
    pub json_schema_contract: bool,
}

/// Resolved paths under the AtomicMemory data directory.
#[derive(Debug, Clone)]
pub struct SlmPaths {
    root: PathBuf,
}

impl SlmPaths {
    pub fn at(root: PathBuf) -> Self {
        Self { root }
    }

    /// Managed runtime root directory (data-local `slm/`).
    #[allow(dead_code)] // public accessor for callers / future doctor paths
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn bin_dir(&self) -> PathBuf {
        self.root.join("bin")
    }

    pub fn binary(&self) -> PathBuf {
        self.bin_dir().join("am-slm")
    }

    pub fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    pub fn pid_path(&self) -> PathBuf {
        self.root.join("am-slm.pid")
    }

    pub fn log_path(&self) -> PathBuf {
        self.root.join("am-slm.log")
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.root.join("staging")
    }

    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(self.bin_dir()).context("create am-slm bin directory")?;
        fs::create_dir_all(self.staging_dir()).context("create am-slm staging directory")?;
        Ok(())
    }

    pub fn read_state(&self) -> Result<SlmStateFile> {
        let path = self.state_path();
        if !path.exists() {
            return Ok(SlmStateFile::default());
        }
        let raw = fs::read_to_string(&path).context("read am-slm state.json")?;
        serde_json::from_str(&raw).context("parse am-slm state.json")
    }

    pub fn write_state(&self, state: &SlmStateFile) -> Result<()> {
        self.ensure()?;
        let raw = serde_json::to_string_pretty(state).context("serialize am-slm state")?;
        let tmp = self.root.join("state.json.tmp");
        fs::write(&tmp, raw.as_bytes()).context("write am-slm state tmp")?;
        fs::rename(&tmp, self.state_path()).context("replace am-slm state.json")?;
        Ok(())
    }
}

/// Default managed root: `{data_local}/slm`.
pub fn default_slm_paths() -> Result<SlmPaths> {
    let dirs = ProjectDirs::from("ai", "atomicstrata", "atomicmemory")
        .ok_or_else(|| anyhow!("cannot resolve AtomicMemory data directory"))?;
    Ok(SlmPaths::at(dirs.data_local_dir().join("slm")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn state_round_trip() {
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        let state = SlmStateFile {
            installed_version: Some("0.1.1".into()),
            managed_process: true,
            pid: Some(42),
            port: Some(8080),
            embedding_dimensions: Some(768),
            ..SlmStateFile::default()
        };
        paths.write_state(&state).unwrap();
        assert_eq!(paths.read_state().unwrap(), state);
    }
}
