//! Scope resolution for `am memory` commands.
//!
//! This is the single chokepoint where CLI scope flags become the wire scope
//! Core enforces, so the isolation rules are validated here once rather than
//! per subcommand.
//!
//! Core drives all isolation off `workspace_id`:
//!
//! - `workspace_id` **without** `agent_id` is not a workspace query. The
//!   query paths (`list`/`get`/`delete`) reject it outright, and the body
//!   paths (`ingest`/`search`) silently drop it (`buildWorkspaceContext`
//!   returns `undefined` unless both are present), storing/reading
//!   user-wide instead. Accepting that combination client-side would promise
//!   an isolation boundary that never exists.
//! - `agent_id` **without** `workspace_id` never filters anything: every
//!   handler takes its non-workspace branch and ignores the agent id, so the
//!   caller silently gets user-wide results they believe are agent-scoped.
//!
//! Both halves are therefore required together, and `agent_id` must be a
//! UUID (Core's own query schema requires it). Anything else fails closed
//! with an actionable message instead of degrading silently.

use anyhow::{Result, bail};
use uuid::Uuid;

use crate::cli::GlobalOptions;
use crate::commands::client::ScopeIdentity;

#[derive(Debug, Clone)]
pub struct MemoryScope {
    pub user_id: String,
    pub agent_id: Option<String>,
    pub workspace_id: Option<String>,
    pub session_id: Option<String>,
    pub namespace_scope: Option<String>,
}

/// Commands whose Core request type can actually carry a namespace scope.
/// `--scope-namespace` is rejected elsewhere rather than silently dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamespaceSupport {
    /// `CoreSearchRequest` carries `namespace_scope`.
    Supported,
    /// `CoreIngestRequest` / list / get / delete have no namespace field.
    Unsupported,
}

pub fn resolve_memory_scope(
    global: &GlobalOptions,
    session: Option<String>,
    agent_id: Option<String>,
    workspace: Option<String>,
) -> Result<MemoryScope> {
    resolve_memory_scope_with(
        global,
        session,
        agent_id,
        workspace,
        NamespaceSupport::Supported,
    )
}

/// Trim a scope value and treat blank as absent.
///
/// Core maps empty query values to `undefined`, so an empty string is not a
/// narrower scope, it is *no* scope.
fn normalize_scope(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn resolve_memory_scope_with(
    global: &GlobalOptions,
    session: Option<String>,
    agent_id: Option<String>,
    workspace: Option<String>,
    namespace: NamespaceSupport,
) -> Result<MemoryScope> {
    let session_id = session.or_else(|| global.scope_thread.clone());
    // `--session`/`--scope-thread` is a session dimension only. It used to
    // fall back to `user_id`, which silently partitioned writes from reads
    // (ingest with --session went to user_id=<session>, every later read
    // used "default"). The two dimensions are orthogonal.
    let user_id = global
        .scope_user
        .clone()
        .unwrap_or_else(|| "default".to_string());
    // Normalize before the pairing check. An empty or whitespace-only value is
    // not a scope: Core's `OptionalQueryField` maps `""` to `undefined`, so
    // `--scope-workspace ''` would satisfy a naive `Some(_)` test here and then
    // be dropped server-side, leaving the request user-wide while the envelope
    // still advertised an agent scope. Treat blank as absent so it fails the
    // both-or-neither rule instead of slipping through it.
    let agent_id = normalize_scope(agent_id.or_else(|| global.scope_agent_id.clone()));
    let workspace_id = normalize_scope(workspace.or_else(|| global.scope_workspace.clone()));

    match (workspace_id.as_deref(), agent_id.as_deref()) {
        (Some(_), None) => bail!(
            "workspace scope requires an agent id: pass --agent-id <uuid> (or ATOMICMEMORY_SCOPE_AGENT_ID).\n\
             Core only applies workspace isolation when both are present; without an agent id the \
             memory would be stored and read user-wide instead of isolated to the workspace."
        ),
        (None, Some(_)) => bail!(
            "agent scope requires a workspace: pass --workspace <id> (or ATOMICMEMORY_SCOPE_WORKSPACE).\n\
             Core only applies agent scoping inside a workspace; an agent id on its own does not \
             filter results, so the command would silently return user-wide memories."
        ),
        (Some(_), Some(agent)) if Uuid::parse_str(agent).is_err() => {
            bail!("--agent-id must be a UUID (Core rejects non-UUID agent ids); got {agent:?}")
        }
        _ => {}
    }

    if namespace == NamespaceSupport::Unsupported && global.scope_namespace.is_some() {
        bail!(
            "--scope-namespace is not supported by this command.\n\
             Core's ingest/list/get/delete requests carry no namespace field, so the flag would be \
             silently ignored. Namespace scoping applies to `am memory search` and `am memory package`."
        );
    }

    Ok(MemoryScope {
        user_id,
        agent_id,
        workspace_id,
        session_id,
        namespace_scope: match namespace {
            NamespaceSupport::Supported => global.scope_namespace.clone(),
            NamespaceSupport::Unsupported => None,
        },
    })
}

/// Bind a Connected Local identity into memory request scope.
///
/// An unset `--scope-user` takes the identity instead of `"default"`.
/// Under an enforced identity (Cloud-minted JWT) Core's
/// `enforceMemoryUserBinding` rejects any other `user_id`, so a conflicting
/// override fails closed before the request. Under a static Core key Core
/// applies no binding, so an explicit override is the operator's choice and
/// wins.
pub fn bind_memory_user(
    scope: &mut MemoryScope,
    identity: &ScopeIdentity,
    explicit_scope_user: Option<&str>,
) -> Result<()> {
    let user = identity.user.trim();
    if user.is_empty() {
        bail!("Connected Local identity is empty — run `am auth login` and retry");
    }
    match explicit_scope_user.map(str::trim).filter(|s| !s.is_empty()) {
        Some(explicit) if explicit != user => {
            if identity.enforced {
                bail!(
                    "--scope-user conflicts with Connected Local JWT identity.\n\
                     Omit --scope-user to use the logged-in identity, or pass --scope-user matching that identity."
                );
            }
            scope.user_id = explicit.to_string();
        }
        _ => scope.user_id = user.to_string(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const MINTED: &str = "user_member";

    fn jwt() -> ScopeIdentity {
        ScopeIdentity {
            user: MINTED.into(),
            enforced: true,
        }
    }

    fn managed_key() -> ScopeIdentity {
        ScopeIdentity {
            user: MINTED.into(),
            enforced: false,
        }
    }

    fn global_with(user: Option<&str>, thread: Option<&str>) -> GlobalOptions {
        GlobalOptions {
            scope_user: user.map(str::to_string),
            scope_thread: thread.map(str::to_string),
            ..GlobalOptions::default()
        }
    }

    fn default_scope() -> MemoryScope {
        resolve_memory_scope(&global_with(None, None), None, None, None).unwrap()
    }

    #[test]
    fn jwt_bind_replaces_default_user_when_no_override() {
        let mut scope = default_scope();
        assert_eq!(scope.user_id, "default");
        bind_memory_user(&mut scope, &jwt(), None).unwrap();
        assert_eq!(scope.user_id, MINTED);
    }

    #[test]
    fn jwt_bind_allows_matching_explicit_override() {
        let mut scope =
            resolve_memory_scope(&global_with(Some(MINTED), None), None, None, None).unwrap();
        bind_memory_user(&mut scope, &jwt(), Some(MINTED)).unwrap();
        assert_eq!(scope.user_id, MINTED);
    }

    #[test]
    fn jwt_bind_rejects_conflicting_explicit_override() {
        let mut scope =
            resolve_memory_scope(&global_with(Some("other"), None), None, None, None).unwrap();
        let err = bind_memory_user(&mut scope, &jwt(), Some("other"))
            .expect_err("conflicting --scope-user must fail closed")
            .to_string();
        assert!(
            err.contains("conflicts with Connected Local JWT identity"),
            "{err}"
        );
        assert_eq!(scope.user_id, "other");
    }

    #[test]
    fn managed_key_defaults_to_session_identity() {
        let mut scope = default_scope();
        bind_memory_user(&mut scope, &managed_key(), None).unwrap();
        assert_eq!(scope.user_id, MINTED);
    }

    #[test]
    fn managed_key_allows_explicit_override() {
        // Core applies no user binding under a static key, so an explicit
        // namespace (e.g. data written to `default` before binding existed)
        // must stay reachable.
        let mut scope =
            resolve_memory_scope(&global_with(Some("default"), None), None, None, None).unwrap();
        bind_memory_user(&mut scope, &managed_key(), Some(" default ")).unwrap();
        assert_eq!(scope.user_id, "default");
    }

    #[test]
    fn empty_identity_fails_closed_on_both_paths() {
        for enforced in [true, false] {
            let identity = ScopeIdentity {
                user: "  ".into(),
                enforced,
            };
            assert!(bind_memory_user(&mut default_scope(), &identity, None).is_err());
        }
    }

    /// Every memory→Core surface that resolves scope must bind JWT identity
    /// through `memory_client_with_scope`. A sibling that calls `memory_client`
    /// after `resolve_memory_scope*` without the binder reintroduces the
    /// user_id=default / minted-sub mismatch.
    #[test]
    fn jwt_scope_binder_covers_memory_and_hook_surfaces() {
        let roots = [
            ("mod.rs", include_str!("mod.rs")),
            ("package.rs", include_str!("package.rs")),
            ("hooks/run.rs", include_str!("../../hooks/run.rs")),
        ];
        for (name, src) in roots {
            let production = src
                .split("#[cfg(test)]")
                .next()
                .expect("production source before tests");
            let unbound = production
                .lines()
                .filter(|line| {
                    let t = line.trim_start();
                    !t.starts_with("//")
                        && (t.contains("memory_client(global)")
                            || t.contains("memory_client(&global)"))
                })
                .count();
            assert_eq!(
                unbound, 0,
                "{name}: memory/hook surfaces must use memory_client_with_scope, not bare memory_client"
            );
            assert!(
                production.contains("memory_client_with_scope"),
                "{name}: expected memory_client_with_scope in JWT-bound surface"
            );
        }
    }

    #[test]
    fn user_only_does_not_set_session() {
        let scope =
            resolve_memory_scope(&global_with(Some("alice"), None), None, None, None).unwrap();
        assert_eq!(scope.user_id, "alice");
        assert!(scope.session_id.is_none());
    }

    #[test]
    fn thread_sets_session_not_user() {
        let scope =
            resolve_memory_scope(&global_with(None, Some("thread-1")), None, None, None).unwrap();
        assert_eq!(scope.session_id.as_deref(), Some("thread-1"));
        assert_eq!(scope.user_id, "default");
    }

    #[test]
    fn session_never_becomes_user_id() {
        // Regression: `--session sess` used to also set user_id="sess" when
        // --scope-user was unset, so a later read under "default" could not
        // see what the write stored.
        let scope = resolve_memory_scope(&global_with(None, None), Some("sess".into()), None, None)
            .unwrap();
        assert_eq!(scope.user_id, "default");
        assert_eq!(scope.session_id.as_deref(), Some("sess"));
    }

    #[test]
    fn explicit_user_and_session_are_orthogonal() {
        let scope = resolve_memory_scope(
            &global_with(Some("alice"), None),
            Some("sess".into()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(scope.user_id, "alice");
        assert_eq!(scope.session_id.as_deref(), Some("sess"));
    }

    #[test]
    fn workspace_without_agent_id_fails_closed() {
        // Core silently drops workspace scope without an agent id on the body
        // paths, so accepting this would promise isolation that never happens.
        let err = resolve_memory_scope(
            &global_with(None, None),
            None,
            None,
            Some("tenant-a".into()),
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("workspace scope requires an agent id"),
            "{err}"
        );
    }

    #[test]
    fn agent_id_without_workspace_fails_closed() {
        // agent_id alone never filters on any Core path — the caller would get
        // user-wide results they believe are agent-scoped.
        let err = resolve_memory_scope(&global_with(None, None), None, Some(AGENT.into()), None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("agent scope requires a workspace"), "{err}");
    }

    #[test]
    fn blank_workspace_is_not_a_scope() {
        // Regression: `--scope-workspace ''` satisfied a `Some(_)` test and
        // then got dropped by Core, so the request went out user-wide while
        // the envelope still advertised an agent scope.
        for blank in ["", "   ", "\t"] {
            let err = resolve_memory_scope(
                &global_with(None, None),
                None,
                Some(AGENT.into()),
                Some(blank.into()),
            )
            .unwrap_err()
            .to_string();
            assert!(
                err.contains("agent scope requires a workspace"),
                "blank workspace {blank:?} must not count as a scope, got: {err}"
            );
        }
    }

    #[test]
    fn blank_agent_id_is_not_a_scope() {
        let err = resolve_memory_scope(
            &global_with(None, None),
            None,
            Some("  ".into()),
            Some("tenant-a".into()),
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("workspace scope requires an agent id"),
            "{err}"
        );
    }

    #[test]
    fn scope_values_are_trimmed() {
        let scope = resolve_memory_scope(
            &global_with(None, None),
            None,
            Some(format!("  {AGENT}  ")),
            Some("  tenant-a  ".into()),
        )
        .unwrap();
        assert_eq!(scope.workspace_id.as_deref(), Some("tenant-a"));
        assert_eq!(scope.agent_id.as_deref(), Some(AGENT));
    }

    #[test]
    fn non_uuid_agent_id_is_rejected() {
        let err = resolve_memory_scope(
            &global_with(None, None),
            None,
            Some("not-a-uuid".into()),
            Some("tenant-a".into()),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("must be a UUID"), "{err}");
    }

    #[test]
    fn workspace_and_uuid_agent_id_resolve_together() {
        let scope = resolve_memory_scope(
            &global_with(None, None),
            None,
            Some(AGENT.into()),
            Some("tenant-a".into()),
        )
        .unwrap();
        assert_eq!(scope.workspace_id.as_deref(), Some("tenant-a"));
        assert_eq!(scope.agent_id.as_deref(), Some(AGENT));
    }

    #[test]
    fn global_workspace_applies_to_read_paths() {
        // `--scope-workspace` is what lets search/list/get/delete scope at all;
        // before it existed those paths always sent workspace_id=None.
        let global = GlobalOptions {
            scope_workspace: Some("tenant-a".into()),
            scope_agent_id: Some(AGENT.into()),
            ..GlobalOptions::default()
        };
        let scope = resolve_memory_scope(&global, None, None, None).unwrap();
        assert_eq!(scope.workspace_id.as_deref(), Some("tenant-a"));
        assert_eq!(scope.agent_id.as_deref(), Some(AGENT));
    }

    #[test]
    fn namespace_rejected_where_the_wire_cannot_carry_it() {
        let global = GlobalOptions {
            scope_namespace: Some("team-a".into()),
            ..GlobalOptions::default()
        };
        let err =
            resolve_memory_scope_with(&global, None, None, None, NamespaceSupport::Unsupported)
                .unwrap_err()
                .to_string();
        assert!(err.contains("--scope-namespace is not supported"), "{err}");

        let scope =
            resolve_memory_scope_with(&global, None, None, None, NamespaceSupport::Supported)
                .unwrap();
        assert_eq!(scope.namespace_scope.as_deref(), Some("team-a"));
    }
}
