//! Build MCP server env blocks from the active `am` profile.

use anyhow::{Result, bail};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::cli::GlobalOptions;
use crate::commands::client::resolve_ctx;
use crate::config::{ProfileKind, require_api_key, resolve_core_api_key};
use crate::integrate::host::Host;
use crate::integrate::path_util::require_npx;

// The pin must always be a version already published on npm, so `am integrate`
// never generates an MCP config that installs a 404. It may lag the in-repo
// `packages/mcp-server/package.json` version while a bump is in flight, and it
// moves up as part of the release that publishes the matching version.
//
// Two guards split the invariant: the build-time
// `mcp_server_pin_is_publishable` test enforces "lag, never race ahead" against
// the in-repo version, and the release-cli `preflight-mcp-pin` job enforces
// "actually resolvable on npm". The build-time test alone does not prove the
// pin is published, so a bump belongs in the same release train as the publish
// and must not land ahead of it.
pub const MCP_SERVER_PACKAGE: &str = "@atomicmemory/mcp-server@0.1.5";

/// Resolved credentials for writing into host MCP configs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IntegrateCredentials {
    pub api_url: String,
    pub api_key: String,
    pub scope_user: String,
    pub scope_namespace: Option<String>,
    pub profile_name: String,
    pub profile_kind: ProfileKind,
}

pub async fn resolve_credentials(global: &GlobalOptions) -> Result<IntegrateCredentials> {
    let profile = resolve_ctx(global).await?;
    let scope_user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "default".to_string());
    let scope_namespace = profile.project_id.clone();

    let (api_url, api_key) = match profile.kind {
        ProfileKind::Local => {
            let url = profile.memory_base_url.clone();
            let key = resolve_local_core_key(&profile.name, &url).await?;
            (url, key)
        }
        ProfileKind::Cloud => {
            let url = profile.memory_base_url.clone();
            let key = require_api_key(&profile)?;
            (url, key)
        }
    };

    Ok(IntegrateCredentials {
        api_url,
        api_key,
        scope_user,
        scope_namespace,
        profile_name: profile.name,
        profile_kind: profile.kind,
    })
}

pub fn preflight_install_runtime() -> Result<()> {
    require_npx()
}

async fn resolve_local_core_key(profile_name: &str, local_url: &str) -> Result<String> {
    if let Some(key) = resolve_core_api_key() {
        return Ok(key);
    }
    if let Some(key) = crate::instance::read_managed_core_api_key(profile_name, local_url).await {
        return Ok(key);
    }
    bail!(
        "local Core API key unavailable — run `am instance start` or set CORE_API_KEY, then retry"
    )
}

fn push_scope_env(env: &mut Map<String, Value>, creds: &IntegrateCredentials, host: Host) {
    env.insert(
        "ATOMICMEMORY_API_URL".into(),
        Value::String(creds.api_url.clone()),
    );
    env.insert(
        "ATOMICMEMORY_API_KEY".into(),
        Value::String(creds.api_key.clone()),
    );
    env.insert(
        "ATOMICMEMORY_PROVIDER".into(),
        Value::String("atomicmemory".into()),
    );
    env.insert(
        "ATOMICMEMORY_SCOPE_USER".into(),
        Value::String(creds.scope_user.clone()),
    );
    env.insert(
        "ATOMICMEMORY_SCOPE_AGENT".into(),
        Value::String(host.scope_agent().into()),
    );
    env.insert(
        "ATOMICMEMORY_SCOPE_LOCK".into(),
        Value::String("true".into()),
    );
    if let Some(ns) = &creds.scope_namespace {
        env.insert(
            "ATOMICMEMORY_SCOPE_NAMESPACE".into(),
            Value::String(ns.clone()),
        );
    }
}

/// JSON MCP server entry for Cursor / Claude Code.
pub fn json_mcp_server(creds: &IntegrateCredentials, host: Host) -> Value {
    let mut env = Map::new();
    push_scope_env(&mut env, creds, host);
    let (command, args) = launcher_command();
    json!({
        "type": "stdio",
        "command": command,
        "args": args,
        "env": Value::Object(env),
    })
}

/// Codex TOML table for `[mcp_servers.atomicmemory]`.
pub fn codex_mcp_table(creds: &IntegrateCredentials, host: Host) -> toml::Value {
    let mut env = toml::map::Map::new();
    env.insert(
        "ATOMICMEMORY_API_URL".into(),
        toml::Value::String(creds.api_url.clone()),
    );
    env.insert(
        "ATOMICMEMORY_API_KEY".into(),
        toml::Value::String(creds.api_key.clone()),
    );
    env.insert(
        "ATOMICMEMORY_PROVIDER".into(),
        toml::Value::String("atomicmemory".into()),
    );
    env.insert(
        "ATOMICMEMORY_SCOPE_USER".into(),
        toml::Value::String(creds.scope_user.clone()),
    );
    env.insert(
        "ATOMICMEMORY_SCOPE_AGENT".into(),
        toml::Value::String(host.scope_agent().into()),
    );
    env.insert(
        "ATOMICMEMORY_SCOPE_LOCK".into(),
        toml::Value::String("true".into()),
    );
    if let Some(ns) = &creds.scope_namespace {
        env.insert(
            "ATOMICMEMORY_SCOPE_NAMESPACE".into(),
            toml::Value::String(ns.clone()),
        );
    }

    let (command, args) = launcher_command();
    let mut table = toml::map::Map::new();
    table.insert("command".into(), toml::Value::String(command));
    table.insert(
        "args".into(),
        toml::Value::Array(
            args.into_iter()
                .map(toml::Value::String)
                .collect::<Vec<_>>(),
        ),
    );
    table.insert("env".into(), toml::Value::Table(env));
    toml::Value::Table(table)
}

fn launcher_command() -> (String, Vec<String>) {
    let npx_args = vec![
        "-y".into(),
        "--package".into(),
        MCP_SERVER_PACKAGE.into(),
        "atomicmemory-mcp".into(),
    ];
    #[cfg(windows)]
    {
        let mut args = vec!["/c".into(), "npx".into()];
        args.extend(npx_args);
        return ("cmd".into(), args);
    }
    #[cfg(not(windows))]
    {
        ("npx".into(), npx_args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_mcp_includes_scope_lock_and_pin() {
        let creds = IntegrateCredentials {
            api_url: "http://127.0.0.1:17350".into(),
            api_key: "local-dev-key".into(),
            scope_user: "pip".into(),
            scope_namespace: Some("proj".into()),
            profile_name: "local".into(),
            profile_kind: ProfileKind::Local,
        };
        let entry = json_mcp_server(&creds, Host::Cursor);
        assert_eq!(entry["env"]["ATOMICMEMORY_SCOPE_LOCK"], "true");
        assert!(
            entry["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str() == Some(MCP_SERVER_PACKAGE))
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_launcher_uses_cmd() {
        let (cmd, args) = launcher_command();
        assert_eq!(cmd, "cmd");
        assert_eq!(args[0], "/c");
        assert_eq!(args[1], "npx");
    }

    #[test]
    fn readme_documents_current_mcp_server_pin() {
        let readme = include_str!("../../README.md");
        assert!(
            readme.contains(&format!("`{MCP_SERVER_PACKAGE}`")),
            "crates/cli/README.md must document the current MCP_SERVER_PACKAGE pin ({MCP_SERVER_PACKAGE})"
        );
    }

    /// Guard `MCP_SERVER_PACKAGE` against racing ahead of the in-repo
    /// `packages/mcp-server/package.json` version. Because the pin is what
    /// `am integrate` embeds into host MCP configs (and `npx` immediately
    /// tries to resolve on `registry.npmjs.org`), it MUST already be a
    /// published version. It is allowed to lag the in-repo package while a
    /// bump is in flight; the release-cli preflight enforces the "actually
    /// resolvable on npm" side of the invariant at release time.
    ///
    /// This test catches the reverse mistake: bumping the pin to a version
    /// that has not been packaged yet in this repo (and therefore has not
    /// been through publish review), which would silently ship a 404 to
    /// every user of `am integrate` and every local source build.
    #[test]
    fn mcp_server_pin_is_publishable() {
        let package_json = include_str!("../../../../packages/mcp-server/package.json");
        let package_version = extract_json_version(package_json)
            .expect("packages/mcp-server/package.json must contain a top-level \"version\"");

        let pin_version = MCP_SERVER_PACKAGE
            .strip_prefix("@atomicmemory/mcp-server@")
            .unwrap_or_else(|| {
                panic!(
                    "MCP_SERVER_PACKAGE ({MCP_SERVER_PACKAGE}) must be \
                     '@atomicmemory/mcp-server@<version>'"
                )
            });

        let pin_semver = parse_semver_triple(pin_version).unwrap_or_else(|| {
            panic!("MCP_SERVER_PACKAGE version '{pin_version}' is not a plain X.Y.Z")
        });
        let package_semver = parse_semver_triple(&package_version).unwrap_or_else(|| {
            panic!(
                "packages/mcp-server/package.json version '{package_version}' \
                 is not a plain X.Y.Z"
            )
        });

        assert!(
            pin_semver <= package_semver,
            "MCP_SERVER_PACKAGE ({MCP_SERVER_PACKAGE}) races ahead of \
             packages/mcp-server/package.json ({package_version}). The pin \
             must always be <= the in-repo package version, so `am integrate` \
             never asks npm for a build that has not been prepared for \
             publish. Bump the pin AFTER publishing @atomicmemory/mcp-server@\
             {package_version} to npm, not before."
        );
    }

    fn extract_json_version(text: &str) -> Option<String> {
        for raw in text.lines() {
            let line = raw.trim();
            let Some(rest) = line.strip_prefix("\"version\"") else {
                continue;
            };
            let after_colon = rest.trim_start().strip_prefix(':')?.trim_start();
            let after_quote = after_colon.strip_prefix('"')?;
            let end = after_quote.find('"')?;
            return Some(after_quote[..end].to_string());
        }
        None
    }

    fn parse_semver_triple(version: &str) -> Option<(u64, u64, u64)> {
        let mut parts = version.split('.');
        let major = parts.next()?.parse::<u64>().ok()?;
        let minor = parts.next()?.parse::<u64>().ok()?;
        let patch = parts.next()?.parse::<u64>().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some((major, minor, patch))
    }
}
