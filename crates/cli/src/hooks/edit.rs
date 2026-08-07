//! Ownership-aware hook config edits for Codex TOML and Claude Code JSON.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use toml_edit::{ArrayOfTables, DocumentMut, Item, Table, Value as TomlValue};

use crate::hooks::types::{HookEvent, HookHost};
use crate::integrate::codex_edit::write_codex_document;

/// Which tool a `hooks run` command belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookOwner {
    /// The Rust `am` binary.
    Am,
    /// The legacy npm CLI this consolidation replaces. Still "ours" for
    /// install/uninstall (so a prior npm install can be retargeted or removed),
    /// but reported separately by `am hooks doctor`.
    LegacyNpm,
}

const CODEX_EVENTS: [HookEvent; 3] = [
    HookEvent::UserPromptSubmit,
    HookEvent::PostCompact,
    HookEvent::Stop,
];

/// True when `command` is a hook invocation *this tool owns*.
///
/// Ownership decides what `uninstall` deletes and what `install` treats as
/// already-present, so it must be structural. A bare `command.contains("hooks
/// run")` substring test claimed any user hook that happened to contain those
/// words (`/opt/acme hooks run cleanup`, `python manage.py hooks run`):
/// uninstall deleted them, and install skipped its own entry because a foreign
/// command looked "already installed".
///
/// The rule is a grammar over the *invoked program*, not a search for our name
/// anywhere in the string. Only two shapes are ours:
///
/// ```text
/// <am|atomicmemory> hooks run …          # what both installers write
/// npx [flags] <atomicmemory|@atomicmemory/cli> hooks run …
/// ```
///
/// Anything else is a third-party command that merely mentions us, e.g.
/// `echo am hooks run cleanup` or `python /opt/am hooks run cleanup`, where the
/// program actually invoked is `echo` / `python`. Claiming those would let
/// uninstall delete them.
pub fn is_owned_command(command: &str) -> bool {
    command_owner(command).is_some()
}

/// Identify the owner of a hook command, or `None` for a third-party command.
pub fn command_owner(command: &str) -> Option<HookOwner> {
    let tokens = tokenize(command);
    let hooks_at = tokens
        .windows(2)
        .position(|pair| pair[0] == "hooks" && pair[1] == "run")?;
    if hooks_at == 0 {
        return None;
    }

    // Direct invocation: argv[0] is our program and `hooks run` is its first
    // subcommand. Requiring adjacency stops `am --flag something hooks run`
    // style false positives from counting.
    if let Some(owner) = program_owner(&tokens[0]) {
        return (hooks_at == 1).then_some(owner);
    }

    // npx wrapper: the invoked package is the first non-flag argument, and it
    // must be immediately followed by `hooks run`.
    if file_stem_of(&tokens[0]) == "npx" {
        let package_at = (1..hooks_at).find(|&i| !tokens[i].starts_with('-'))?;
        if package_at + 1 != hooks_at {
            return None;
        }
        return match tokens[package_at].as_str() {
            "@atomicmemory/cli" | "atomicmemory" => Some(HookOwner::LegacyNpm),
            _ => None,
        };
    }

    None
}

/// Split a command line into argv-ish tokens, honoring quotes so a program
/// path containing spaces (which [`hook_command`] quotes) stays one token.
fn tokenize(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in command.chars() {
        match quote {
            Some(open) if ch == open => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn file_stem_of(token: &str) -> &str {
    std::path::Path::new(token)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(token)
}

fn program_owner(token: &str) -> Option<HookOwner> {
    match file_stem_of(token) {
        "am" => Some(HookOwner::Am),
        "atomicmemory" => Some(HookOwner::LegacyNpm),
        _ => None,
    }
}

/// Owners of the hook commands declared in a parsed Claude `settings.json`.
///
/// `doctor` parses the host config rather than scanning raw text: a serialized
/// command is a single quoted JSON/TOML value, so the argv grammar in
/// [`command_owner`] cannot be applied to the surrounding line (the whole
/// command collapses into one token behind `"command":`). Parsing keeps
/// install, uninstall, and doctor on one definition of ownership.
pub fn claude_hook_owners(root: &Value) -> Vec<HookOwner> {
    let mut owners = Vec::new();
    let Some(events) = root.get("hooks").and_then(|hooks| hooks.as_object()) else {
        return owners;
    };
    for groups in events.values() {
        for group in groups.as_array().into_iter().flatten() {
            for hook in group
                .get("hooks")
                .and_then(|hooks| hooks.as_array())
                .into_iter()
                .flatten()
            {
                push_owner(
                    &mut owners,
                    hook.get("command").and_then(|command| command.as_str()),
                );
            }
        }
    }
    owners
}

/// Owners of the hook commands declared in a parsed Codex `config.toml`.
pub fn codex_hook_owners(doc: &DocumentMut) -> Vec<HookOwner> {
    let mut owners = Vec::new();
    let Some(hooks) = doc.get("hooks").and_then(|item| item.as_table()) else {
        return owners;
    };
    for (_event, entry) in hooks.iter() {
        let Some(entries) = entry.as_array_of_tables() else {
            continue;
        };
        for table in entries.iter() {
            match table.get("hooks") {
                Some(Item::ArrayOfTables(inner)) => {
                    for hook in inner.iter() {
                        push_owner(
                            &mut owners,
                            hook.get("command")
                                .and_then(|item| item.as_value())
                                .and_then(|value| value.as_str()),
                        );
                    }
                }
                Some(Item::Value(TomlValue::Array(items))) => {
                    for hook in items.iter().filter_map(|value| value.as_inline_table()) {
                        push_owner(
                            &mut owners,
                            hook.get("command").and_then(|value| value.as_str()),
                        );
                    }
                }
                _ => {}
            }
        }
    }
    owners
}

fn push_owner(owners: &mut Vec<HookOwner>, command: Option<&str>) {
    if let Some(owner) = command.and_then(command_owner)
        && !owners.contains(&owner)
    {
        owners.push(owner);
    }
}

/// Quote a program path that contains shell-significant characters: the
/// composed string is executed by the host's shell, so an `am` installed under
/// a path with spaces would otherwise word-split into a broken command.
///
/// Double quotes (not single) so Windows paths keep working; backslash is left
/// unescaped for the same reason, and the characters that are special *inside*
/// POSIX double quotes are escaped.
fn shell_quote(path: &str) -> String {
    if path.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quoting = !path.chars().all(|c| {
        c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '~' | '+' | ':' | '@' | '\\')
    });
    if !needs_quoting {
        return path.to_string();
    }
    let escaped = path
        .replace('"', "\\\"")
        .replace('$', "\\$")
        .replace('`', "\\`");
    format!("\"{escaped}\"")
}

pub fn hook_command(am_path: &str, event: HookEvent, host: HookHost) -> String {
    format!(
        "{} hooks run {} --host {}",
        shell_quote(am_path),
        event.cli_name(),
        host.id()
    )
}

pub fn merge_codex_hooks(doc: &mut DocumentMut, am_path: &str, host: HookHost) -> Result<bool> {
    let mut changed = false;
    if ensure_codex_hooks_feature(doc) {
        changed = true;
    }
    for event in CODEX_EVENTS {
        if merge_codex_event(doc, event, am_path, host)? {
            changed = true;
        }
    }
    Ok(changed)
}

pub fn remove_codex_hooks(doc: &mut DocumentMut) -> Result<bool> {
    let mut changed = false;
    for event in CODEX_EVENTS {
        if remove_codex_event(doc, event)? {
            changed = true;
        }
    }
    Ok(changed)
}

pub fn merge_claude_hooks(root: &mut Value, am_path: &str, host: HookHost) -> Result<bool> {
    let mut changed = false;
    let root_obj = root
        .as_object_mut()
        .context("Claude settings root must be a JSON object")?;
    let hooks_entry = root_obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks_obj = hooks_entry
        .as_object_mut()
        .context("Claude settings.hooks must be a JSON object")?;
    for event in CODEX_EVENTS {
        let key = event.host_event_key();
        let owned = claude_owned_matcher_group(am_path, event, host);
        let event_entry = hooks_obj.entry(key).or_insert_with(|| json!([]));
        let arr = event_entry
            .as_array_mut()
            .context("Claude hook event entries must be arrays")?;
        if arr.iter().any(claude_matcher_group_is_owned) {
            continue;
        }
        arr.push(owned);
        changed = true;
    }
    Ok(changed)
}

pub fn remove_claude_hooks(root: &mut Value) -> Result<bool> {
    let hooks_obj = root
        .as_object_mut()
        .and_then(|o| o.get_mut("hooks"))
        .and_then(|v| v.as_object_mut());
    if hooks_obj.is_none() {
        return Ok(false);
    }
    let hooks_obj = hooks_obj.expect("checked above");
    let mut changed = false;
    for event in CODEX_EVENTS {
        let key = event.host_event_key();
        if let Some(entry) = hooks_obj.get_mut(key) {
            if let Some(arr) = entry.as_array_mut() {
                let before = arr.len();
                arr.retain(|group| !claude_matcher_group_is_owned(group));
                if arr.len() != before {
                    changed = true;
                }
                if arr.is_empty() {
                    hooks_obj.remove(key);
                }
            }
        }
    }
    if hooks_obj.is_empty()
        && root
            .as_object_mut()
            .expect("root object")
            .remove("hooks")
            .is_some()
    {
        changed = true;
    }
    Ok(changed)
}

pub fn write_codex_text(path: &std::path::Path, doc: &DocumentMut) -> Result<()> {
    write_codex_document(path, doc)
}

fn ensure_codex_hooks_feature(doc: &mut DocumentMut) -> bool {
    let features = doc.entry("features").or_insert(Item::Table(Table::new()));
    let table = features.as_table_mut().expect("features table");
    let current = table
        .get("codex_hooks")
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_bool());
    if current == Some(true) {
        return false;
    }
    table.insert("codex_hooks", Item::Value(TomlValue::from(true)));
    true
}

fn merge_codex_event(
    doc: &mut DocumentMut,
    event: HookEvent,
    am_path: &str,
    host: HookHost,
) -> Result<bool> {
    let command = hook_command(am_path, event, host);
    let hooks_table = doc
        .entry("hooks")
        .or_insert(Item::Table(Table::new()))
        .as_table_mut()
        .context("hooks must be a table")?;
    let event_key = event.host_event_key();
    let event_array = hooks_table
        .entry(event_key)
        .or_insert(Item::ArrayOfTables(ArrayOfTables::new()));
    let aot = event_array
        .as_array_of_tables_mut()
        .context("hook event must be an array of tables")?;
    if aot.iter().any(codex_entry_is_owned) {
        return Ok(false);
    }
    let mut entry = Table::new();
    entry.insert("matcher", Item::Value(TomlValue::from(".*")));
    let mut inner = ArrayOfTables::new();
    let mut hook = Table::new();
    hook.insert("type", Item::Value(TomlValue::from("command")));
    hook.insert("command", Item::Value(TomlValue::from(command)));
    hook.insert("timeout", Item::Value(TomlValue::from(10i64)));
    if let Some(msg) = event.status_message() {
        hook.insert("statusMessage", Item::Value(TomlValue::from(msg)));
    }
    inner.push(hook);
    entry.insert("hooks", Item::ArrayOfTables(inner));
    aot.push(entry);
    Ok(true)
}

fn remove_codex_event(doc: &mut DocumentMut, event: HookEvent) -> Result<bool> {
    let hooks_table = doc.get_mut("hooks").and_then(|item| item.as_table_mut());
    if hooks_table.is_none() {
        return Ok(false);
    }
    let hooks_table = hooks_table.expect("checked");
    let event_key = event.host_event_key();
    let event_item = hooks_table.get_mut(event_key);
    if event_item.is_none() {
        return Ok(false);
    }
    let aot = event_item
        .expect("checked")
        .as_array_of_tables_mut()
        .context("hook event must be an array of tables")?;
    let before = aot.len();
    aot.retain(|entry| !codex_entry_is_owned(entry));
    let changed = aot.len() != before;
    if aot.is_empty() {
        hooks_table.remove(event_key);
    }
    if hooks_table.is_empty() {
        doc.remove("hooks");
    }
    Ok(changed)
}

fn codex_entry_is_owned(entry: &Table) -> bool {
    let hooks = entry.get("hooks");
    match hooks {
        Some(Item::ArrayOfTables(inner)) => inner.iter().any(codex_hook_table_is_owned),
        Some(Item::Value(TomlValue::Array(items))) => items
            .iter()
            .filter_map(|v| v.as_inline_table())
            .any(inline_hook_is_owned),
        _ => false,
    }
}

fn codex_hook_table_is_owned(hook: &Table) -> bool {
    hook.get("command")
        .and_then(|item| item.as_value())
        .and_then(|v| v.as_str())
        .is_some_and(is_owned_command)
}

fn inline_hook_is_owned(table: &toml_edit::InlineTable) -> bool {
    table
        .get("command")
        .and_then(|v| v.as_str())
        .is_some_and(is_owned_command)
}

fn claude_owned_matcher_group(am_path: &str, event: HookEvent, host: HookHost) -> Value {
    let command = hook_command(am_path, event, host);
    let mut hook = json!({
        "type": "command",
        "command": command,
        "timeout": 10,
    });
    if let Some(msg) = event.status_message() {
        hook.as_object_mut()
            .expect("hook object")
            .insert("statusMessage".into(), json!(msg));
    }
    json!({ "hooks": [hook] })
}

fn claude_matcher_group_is_owned(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .any(|hook| {
            hook.get("command")
                .and_then(|v| v.as_str())
                .is_some_and(is_owned_command)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_claude_settings() -> Value {
        json!({
            "hooks": {
                "SessionStart": [{
                    "hooks": [{
                        "type": "command",
                        "command": "/other/session.sh",
                        "timeout": 5
                    }]
                }],
                "UserPromptSubmit": [{
                    "hooks": [{
                        "type": "command",
                        "command": "/other/prompt.sh",
                        "timeout": 5
                    }]
                }],
                "Stop": [{
                    "hooks": [{
                        "type": "command",
                        "command": "/other/stop.sh",
                        "timeout": 5
                    }]
                }]
            }
        })
    }

    #[test]
    fn codex_structural_features_and_per_event_merge() {
        let mut doc = DocumentMut::new();
        doc.insert(
            "features",
            Item::Table({
                let mut t = Table::new();
                t.insert("codex_hooks", Item::Value(TomlValue::from(false)));
                t
            }),
        );
        let changed = merge_codex_hooks(&mut doc, "/bin/am", HookHost::Codex).unwrap();
        assert!(changed);
        let features = doc["features"].as_table().expect("features");
        assert_eq!(
            features["codex_hooks"].as_value().and_then(|v| v.as_bool()),
            Some(true)
        );
        let hooks = doc["hooks"].as_table().expect("hooks");
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(hooks.contains_key("PostCompact"));
        assert!(hooks.contains_key("Stop"));
    }

    #[test]
    fn codex_second_merge_is_noop() {
        let mut doc = DocumentMut::new();
        merge_codex_hooks(&mut doc, "/bin/am", HookHost::Codex).unwrap();
        let changed = merge_codex_hooks(&mut doc, "/bin/am", HookHost::Codex).unwrap();
        assert!(!changed);
    }

    #[test]
    fn codex_round_trip_uninstall() {
        let mut doc = DocumentMut::new();
        merge_codex_hooks(&mut doc, "/bin/am", HookHost::Codex).unwrap();
        let changed = remove_codex_hooks(&mut doc).unwrap();
        assert!(changed);
        assert!(doc.get("hooks").is_none());
    }

    #[test]
    fn codex_partial_install_adds_missing_events() {
        let mut doc = DocumentMut::new();
        merge_codex_hooks(&mut doc, "/bin/am", HookHost::Codex).unwrap();
        let hooks = doc["hooks"].as_table_mut().expect("hooks");
        hooks.remove("PostCompact");
        hooks.remove("Stop");
        let changed = merge_codex_hooks(&mut doc, "/bin/am", HookHost::Codex).unwrap();
        assert!(changed);
        let hooks = doc["hooks"].as_table().expect("hooks");
        assert!(hooks.contains_key("PostCompact"));
        assert!(hooks.contains_key("Stop"));
    }

    #[test]
    fn codex_false_codex_hooks_value_is_enabled() {
        let mut doc = DocumentMut::new();
        doc.insert(
            "features",
            Item::Table({
                let mut t = Table::new();
                t.insert("codex_hooks", Item::Value(TomlValue::from(false)));
                t
            }),
        );
        let changed = merge_codex_hooks(&mut doc, "/bin/am", HookHost::Codex).unwrap();
        assert!(changed);
        assert_eq!(
            doc["features"]["codex_hooks"]
                .as_value()
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn codex_uninstall_removes_owned_only() {
        let mut doc = DocumentMut::new();
        merge_codex_hooks(&mut doc, "/bin/am", HookHost::Codex).unwrap();
        doc.insert(
            "mcp_servers",
            Item::Table({
                let mut t = Table::new();
                t.insert(
                    "other",
                    Item::Table({
                        let mut inner = Table::new();
                        inner.insert("command", Item::Value(TomlValue::from("echo")));
                        inner
                    }),
                );
                t
            }),
        );
        let changed = remove_codex_hooks(&mut doc).unwrap();
        assert!(changed);
        assert!(doc.get("hooks").is_none());
        assert!(doc.get("mcp_servers").is_some());
    }

    #[test]
    fn claude_merge_preserves_unrelated_hooks() {
        let mut root = fixture_claude_settings();
        let changed = merge_claude_hooks(&mut root, "/bin/am", HookHost::ClaudeCode).unwrap();
        assert!(changed);
        let hooks = root["hooks"].as_object().expect("hooks");
        assert!(hooks.contains_key("SessionStart"));
        let user = hooks["UserPromptSubmit"].as_array().expect("ups");
        assert_eq!(user.len(), 2);
        assert!(claude_matcher_group_is_owned(&user[1]));
        assert!(!claude_matcher_group_is_owned(&user[0]));
    }

    #[test]
    fn claude_schema_is_array_of_matcher_groups() {
        let group = claude_owned_matcher_group(
            "/bin/am",
            HookEvent::UserPromptSubmit,
            HookHost::ClaudeCode,
        );
        let arr = json!([group]);
        assert!(arr.is_array());
        let hooks = arr[0]["hooks"].as_array().expect("inner hooks");
        assert_eq!(hooks[0]["type"], "command");
    }

    #[test]
    fn claude_round_trip_uninstall() {
        let mut root = fixture_claude_settings();
        merge_claude_hooks(&mut root, "/bin/am", HookHost::ClaudeCode).unwrap();
        let changed = remove_claude_hooks(&mut root).unwrap();
        assert!(changed);
        let hooks = root["hooks"].as_object().expect("hooks");
        let user = hooks["UserPromptSubmit"].as_array().expect("ups");
        assert_eq!(user.len(), 1);
        assert_eq!(user[0]["hooks"][0]["command"], "/other/prompt.sh");
        assert!(hooks.contains_key("SessionStart"));
        assert!(!hooks.contains_key("PostCompact"));
    }

    #[test]
    fn claude_fixture_matches_plugin_schema_shape() {
        let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../plugins/claude-code/hooks/hooks.json");
        let raw = std::fs::read_to_string(&fixture_path).expect("read hooks.json");
        let fixture: Value = serde_json::from_str(&raw).expect("parse fixture");
        let sample = claude_owned_matcher_group(
            "/bin/am",
            HookEvent::UserPromptSubmit,
            HookHost::ClaudeCode,
        );
        let fixture_user = &fixture["hooks"]["UserPromptSubmit"];
        assert!(fixture_user.is_array());
        let fixture_group = &fixture_user[0];
        assert!(
            fixture_group
                .get("hooks")
                .and_then(|v| v.as_array())
                .is_some()
        );
        assert!(sample.get("hooks").and_then(|v| v.as_array()).is_some());
    }

    #[test]
    fn ownership_requires_our_program_not_just_the_words_hooks_run() {
        // Regression: a bare `contains("hooks run")` claimed third-party
        // commands, so uninstall deleted them and install skipped its own
        // entry because a foreign command looked "already installed".
        for foreign in [
            "/opt/acme hooks run cleanup",
            "python manage.py hooks run",
            "/opt/team hooks run nightly",
            "./ci/git-hooks run-all",
            "npm run hooks",
            // The invoked program is what matters, not that our name appears:
            // these run echo/python/sh, so uninstall must not delete them.
            "echo am hooks run cleanup",
            "python /opt/am hooks run cleanup",
            "sh -c 'am hooks run stop'",
            "/usr/bin/env am hooks run stop",
            "wrapper --tool=am hooks run stop",
            // npx form must still name our package immediately before the
            // subcommand.
            "npx some-other-tool hooks run stop",
            "npx @atomicmemory/cli --flag other hooks run stop",
        ] {
            assert!(
                !is_owned_command(foreign),
                "must not claim third-party command: {foreign}"
            );
        }

        for ours in [
            "am hooks run stop --host codex",
            "/usr/local/bin/am hooks run stop --host codex",
            "\"/Users/a b/bin/am\" hooks run stop --host codex",
        ] {
            assert_eq!(command_owner(ours), Some(HookOwner::Am), "{ours}");
        }

        for legacy in [
            // Exactly what the npm installer writes.
            "atomicmemory hooks run stop --host codex",
            "/usr/local/bin/atomicmemory hooks run stop --host codex",
            "npx @atomicmemory/cli hooks run stop --host codex",
            "npx -y @atomicmemory/cli hooks run stop --host codex",
        ] {
            assert_eq!(
                command_owner(legacy),
                Some(HookOwner::LegacyNpm),
                "{legacy}"
            );
        }
    }

    #[test]
    fn owners_are_read_from_parsed_configs_not_raw_lines() {
        // Regression: doctor scanned serialized lines, but a hook command is
        // one quoted value (`"command": "/usr/local/bin/am hooks run ..."`),
        // so the argv grammar never saw `am` as argv[0] and every real
        // install reported installed: false. Ownership is read structurally.
        let mut root = fixture_claude_settings();
        assert!(
            claude_hook_owners(&root).is_empty(),
            "third-party hooks must not be claimed"
        );

        merge_claude_hooks(&mut root, "/usr/local/bin/am", HookHost::ClaudeCode).unwrap();
        assert!(
            claude_hook_owners(&root).contains(&HookOwner::Am),
            "an installed am hook must be detected: {root}"
        );

        // Serializing and re-parsing (what doctor does) must not change it.
        let round_tripped: Value =
            serde_json::from_str(&serde_json::to_string_pretty(&root).unwrap()).unwrap();
        assert!(claude_hook_owners(&round_tripped).contains(&HookOwner::Am));

        let mut doc = DocumentMut::new();
        assert!(codex_hook_owners(&doc).is_empty());
        merge_codex_hooks(&mut doc, "/usr/local/bin/am", HookHost::Codex).unwrap();
        assert!(
            codex_hook_owners(&doc).contains(&HookOwner::Am),
            "codex install must be detected: {doc}"
        );
        let reparsed: DocumentMut = doc.to_string().parse().unwrap();
        assert!(codex_hook_owners(&reparsed).contains(&HookOwner::Am));
    }

    #[test]
    fn parsed_owners_ignore_third_party_commands() {
        let mut root = fixture_claude_settings();
        root["hooks"]["UserPromptSubmit"]
            .as_array_mut()
            .expect("ups")
            .push(json!({
                "hooks": [{ "type": "command", "command": "echo am hooks run cleanup" }]
            }));
        assert!(
            claude_hook_owners(&root).is_empty(),
            "a command that merely mentions am must not count as installed"
        );
    }

    #[test]
    fn tokenizer_keeps_quoted_program_paths_intact() {
        // hook_command quotes paths containing spaces; ownership must survive
        // that or uninstall would orphan our own hook.
        let tokens = tokenize("\"/Users/a b/bin/am\" hooks run stop --host codex");
        assert_eq!(tokens[0], "/Users/a b/bin/am");
        assert_eq!(tokens[1], "hooks");
        assert_eq!(
            command_owner("\"/Users/a b/bin/am\" hooks run stop --host codex"),
            Some(HookOwner::Am)
        );
    }

    #[test]
    fn uninstall_preserves_a_foreign_hook_that_mentions_hooks_run() {
        let mut root = fixture_claude_settings();
        // A user hook whose command coincidentally contains "hooks run".
        root["hooks"]["UserPromptSubmit"]
            .as_array_mut()
            .expect("ups")
            .push(json!({
                "hooks": [{ "type": "command", "command": "/opt/acme hooks run cleanup" }]
            }));
        merge_claude_hooks(&mut root, "/bin/am", HookHost::ClaudeCode).unwrap();

        let changed = remove_claude_hooks(&mut root).unwrap();
        assert!(changed, "our own hook should be removed");

        let remaining = root["hooks"]["UserPromptSubmit"]
            .as_array()
            .expect("ups")
            .iter()
            .filter_map(|group| {
                group
                    .get("hooks")?
                    .as_array()?
                    .first()?
                    .get("command")?
                    .as_str()
            })
            .collect::<Vec<_>>();
        assert!(
            remaining.iter().any(|c| c.contains("/opt/acme")),
            "third-party hook must survive uninstall, got {remaining:?}"
        );
        assert!(
            !remaining.iter().any(|c| is_owned_command(c)),
            "no am-owned hook should remain, got {remaining:?}"
        );
    }

    #[test]
    fn install_is_not_skipped_by_a_lookalike_foreign_hook() {
        let mut root = fixture_claude_settings();
        root["hooks"]["UserPromptSubmit"]
            .as_array_mut()
            .expect("ups")
            .push(json!({
                "hooks": [{ "type": "command", "command": "/opt/acme hooks run cleanup" }]
            }));
        let changed = merge_claude_hooks(&mut root, "/bin/am", HookHost::ClaudeCode).unwrap();
        assert!(changed, "install must not treat a foreign hook as ours");
        let ours_present = root["hooks"]["UserPromptSubmit"]
            .as_array()
            .expect("ups")
            .iter()
            .any(claude_matcher_group_is_owned);
        assert!(ours_present, "our hook should have been installed");
    }

    #[test]
    fn hook_command_quotes_paths_with_spaces() {
        let cmd = hook_command("/Users/a b/bin/am", HookEvent::Stop, HookHost::Codex);
        assert!(cmd.starts_with('"'), "expected quoted path, got {cmd}");
        assert!(is_owned_command(&cmd), "quoted command must stay ours");
        // Plain paths are left alone.
        let plain = hook_command("/usr/local/bin/am", HookEvent::Stop, HookHost::Codex);
        assert_eq!(plain, "/usr/local/bin/am hooks run stop --host codex");
    }
}
