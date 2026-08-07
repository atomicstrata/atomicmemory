//! Comment-preserving Codex config edits via `toml_edit`.

use std::path::Path;

use anyhow::{Context, Result, bail};
use toml_edit::{DocumentMut, InlineTable, Item, Table, Value};

use crate::integrate::fingerprint::fingerprint_toml;
use crate::integrate::host::MCP_SERVER_NAME;
use crate::integrate::write::write_secure_file;

pub fn read_codex_document(path: &Path) -> Result<DocumentMut> {
    if !path.exists() {
        return Ok(DocumentMut::new());
    }
    let raw = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    raw.parse::<DocumentMut>()
        .with_context(|| format!("parse TOML {}", path.display()))
}

pub fn current_codex_entry(doc: &DocumentMut) -> Option<toml::Value> {
    doc.get("mcp_servers")?
        .as_table()?
        .get(MCP_SERVER_NAME)
        .and_then(codex_item_to_toml)
}

fn codex_item_to_toml(item: &Item) -> Option<toml::Value> {
    match item {
        Item::Table(table) => table_item_to_toml(table),
        Item::Value(Value::InlineTable(table)) => Some(inline_table_to_toml(table)),
        Item::Value(value) => edit_value_to_toml(value).map(|value| match value {
            toml::Value::Table(table) => toml::Value::Table(table),
            other => {
                let mut map = toml::map::Map::new();
                map.insert("value".into(), other);
                toml::Value::Table(map)
            }
        }),
        Item::ArrayOfTables(array) => {
            let mut out = Vec::new();
            for table in array.iter() {
                out.push(table_item_to_toml(table)?);
            }
            Some(toml::Value::Array(out))
        }
        Item::None => None,
    }
}

fn table_item_to_toml(table: &Table) -> Option<toml::Value> {
    let mut map = toml::map::Map::new();
    for (key, item) in table.iter() {
        if let Some(converted) = table_child_to_toml(item) {
            map.insert(key.to_string(), converted);
        }
    }
    Some(toml::Value::Table(map))
}

fn table_child_to_toml(item: &Item) -> Option<toml::Value> {
    match item {
        Item::Table(table) => table_item_to_toml(table),
        Item::Value(Value::InlineTable(table)) => Some(inline_table_to_toml(table)),
        Item::Value(value) => edit_value_to_toml(value),
        Item::ArrayOfTables(array) => {
            let mut out = Vec::new();
            for table in array.iter() {
                out.push(table_item_to_toml(table)?);
            }
            Some(toml::Value::Array(out))
        }
        Item::None => None,
    }
}

fn inline_table_to_toml(table: &InlineTable) -> toml::Value {
    let mut map = toml::map::Map::new();
    for (key, value) in table.iter() {
        if let Some(converted) = edit_value_to_toml(value) {
            map.insert(key.to_string(), converted);
        }
    }
    toml::Value::Table(map)
}

fn edit_value_to_toml(value: &Value) -> Option<toml::Value> {
    Some(match value {
        Value::String(s) => toml::Value::String(s.value().to_string()),
        Value::Integer(i) => toml::Value::Integer(*i.value()),
        Value::Float(f) => toml::Value::Float(*f.value()),
        Value::Boolean(b) => toml::Value::Boolean(*b.value()),
        Value::Datetime(dt) => toml::Value::Datetime(*dt.value()),
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items.iter() {
                out.push(edit_value_to_toml(item)?);
            }
            toml::Value::Array(out)
        }
        Value::InlineTable(table) => inline_table_to_toml(table),
    })
}

fn toml_value_to_edit(value: &toml::Value) -> Result<Value> {
    Ok(match value {
        toml::Value::String(s) => Value::from(s.as_str()),
        toml::Value::Integer(i) => Value::from(*i),
        toml::Value::Float(f) => Value::from(*f),
        toml::Value::Boolean(b) => Value::from(*b),
        toml::Value::Datetime(dt) => Value::from(*dt),
        toml::Value::Array(items) => {
            let mut out = toml_edit::Array::new();
            for item in items {
                out.push(toml_value_to_edit(item)?);
            }
            Value::Array(out)
        }
        toml::Value::Table(table) => {
            let mut inline = InlineTable::new();
            for (key, item) in table {
                inline.insert(key, toml_value_to_edit(item)?);
            }
            Value::InlineTable(inline)
        }
    })
}

fn toml_value_to_table(value: &toml::Value) -> Result<Table> {
    let table = value
        .as_table()
        .context("Codex MCP entry must be a TOML table")?;
    let mut out = Table::new();
    for (key, item) in table {
        match item {
            toml::Value::Table(_) => {
                out.insert(key, Item::Table(toml_value_to_table(item)?));
            }
            _ => {
                out.insert(key, Item::Value(toml_value_to_edit(item)?));
            }
        }
    }
    Ok(out)
}

pub fn merge_codex_mcp(
    doc: &mut DocumentMut,
    server_table: toml::Value,
    force: bool,
) -> Result<bool> {
    let new_fp = fingerprint_toml(&server_table)?;
    if let Some(current) = current_codex_entry(doc) {
        let current_fp = fingerprint_toml(&current)?;
        if current_fp == new_fp {
            return Ok(false);
        }
        if !force {
            bail!("existing `{MCP_SERVER_NAME}` entry differs — pass --force to overwrite");
        }
    }
    let servers = doc
        .entry("mcp_servers")
        .or_insert(Item::Table(Table::new()))
        .as_table_mut()
        .context("mcp_servers must be a table")?;
    let table = toml_value_to_table(&server_table)?;
    servers.insert(MCP_SERVER_NAME, Item::Table(table));
    Ok(true)
}

pub fn remove_or_restore_codex_mcp(
    doc: &mut DocumentMut,
    restore_entry: Option<&str>,
) -> Result<bool> {
    let remove_container = {
        let Some(servers) = doc.get_mut("mcp_servers") else {
            return Ok(false);
        };
        let Some(table) = servers.as_table_mut() else {
            return Ok(false);
        };
        if let Some(raw) = restore_entry {
            let parsed: toml::Value =
                toml::from_str(raw).context("parse stored prior Codex entry")?;
            let restored = toml_value_to_table(&parsed)?;
            table.insert(MCP_SERVER_NAME, Item::Table(restored));
            return Ok(true);
        }
        let changed = table.remove(MCP_SERVER_NAME).is_some();
        if !changed {
            return Ok(false);
        }
        table.is_empty()
    };
    if remove_container {
        doc.remove("mcp_servers");
    }
    Ok(true)
}

pub fn write_codex_document(path: &Path, doc: &DocumentMut) -> Result<()> {
    write_secure_file(path, &doc.to_string())
}

pub fn serialize_codex_entry(entry: &toml::Value) -> Result<String> {
    toml::to_string(entry).context("serialize Codex MCP entry")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrate::spec::MCP_SERVER_PACKAGE;

    #[test]
    fn detects_standard_codex_table_syntax() {
        let raw = r#"
[mcp_servers.atomicmemory]
command = "legacy"
args = ["echo"]
"#;
        let doc = raw.parse::<DocumentMut>().unwrap();
        let entry = current_codex_entry(&doc).expect("entry");
        assert_eq!(
            entry.get("command").and_then(|v| v.as_str()),
            Some("legacy")
        );
    }

    #[test]
    fn current_entry_preserves_nested_env_subtable() {
        let raw = r#"
[mcp_servers.atomicmemory]
command = "legacy"
args = ["run"]

[mcp_servers.atomicmemory.env]
SECRET = "s3cr3t"
"#;
        let doc = raw.parse::<DocumentMut>().unwrap();
        let entry = current_codex_entry(&doc).expect("entry");
        let env = entry
            .get("env")
            .and_then(|value| value.as_table())
            .expect("env table");
        assert_eq!(
            env.get("SECRET").and_then(|value| value.as_str()),
            Some("s3cr3t")
        );
    }

    #[test]
    fn current_entry_preserves_datetime_type() {
        let raw = r#"
[mcp_servers.atomicmemory]
command = "legacy"
since = 2021-01-01T00:00:00Z
"#;
        let doc = raw.parse::<DocumentMut>().unwrap();
        let entry = current_codex_entry(&doc).expect("entry");
        let since = entry.get("since").expect("since field");
        assert!(
            since.as_datetime().is_some(),
            "datetime must round-trip as a datetime, not a string: {since:?}"
        );
    }

    #[test]
    fn merge_refuses_unowned_standard_codex_table_without_force() {
        let raw = r#"
[mcp_servers.atomicmemory]
command = "legacy"
"#;
        let mut doc = raw.parse::<DocumentMut>().unwrap();
        let replacement = toml::Value::Table(toml::map::Map::from_iter([
            ("command".into(), toml::Value::String("npx".into())),
            (
                "args".into(),
                toml::Value::Array(vec![toml::Value::String(format!(
                    "--package={MCP_SERVER_PACKAGE}"
                ))]),
            ),
        ]));
        assert!(merge_codex_mcp(&mut doc, replacement, false).is_err());
    }

    #[test]
    fn preserves_unrelated_comments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "# keep me\n[mcp_servers.other]\ncommand = \"echo\"\n",
        )
        .unwrap();
        let mut doc = read_codex_document(&path).unwrap();
        let table = toml::Value::Table(toml::map::Map::from_iter([
            ("command".into(), toml::Value::String("npx".into())),
            (
                "args".into(),
                toml::Value::Array(vec![toml::Value::String(format!(
                    "--package={MCP_SERVER_PACKAGE}"
                ))]),
            ),
        ]));
        merge_codex_mcp(&mut doc, table, false).unwrap();
        let out = doc.to_string();
        assert!(out.contains("# keep me"));
        assert!(out.contains("[mcp_servers.other]"));
    }

    #[test]
    fn remove_without_restore_drops_empty_mcp_servers_table() {
        let raw = r#"
[mcp_servers.atomicmemory]
command = "npx"
"#;
        let mut doc = raw.parse::<DocumentMut>().unwrap();
        let changed = remove_or_restore_codex_mcp(&mut doc, None).unwrap();
        assert!(changed);
        assert!(!doc.to_string().contains("[mcp_servers]"));
    }
}
