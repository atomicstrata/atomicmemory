//! `am health` — Cloud API and local Core reachability check.

use anyhow::Result;

use crate::cli::GlobalOptions;
use crate::commands::client::{dashboard_client, memory_client, resolve_ctx};
use crate::output::emit;

pub async fn run(global: &GlobalOptions) -> Result<()> {
    let profile = resolve_ctx(global).await?;
    let mut report = serde_json::json!({
        "profile": profile.name,
        "base_url": profile.base_url,
        "kind": format!("{:?}", profile.kind),
    });

    if let Ok((_p, dash)) = dashboard_client(global).await
        && let Ok(h) = dash.healthz().await
    {
        report["dashboard_health"] = h;
    }

    if profile.api_key.is_some()
        && let Ok((_p, mem)) = memory_client(global).await
        && let Ok(h) = mem.health().await
    {
        report["memory_health"] = serde_json::to_value(h)?;
    }

    emit(global.output, &report, global.quiet)
}
