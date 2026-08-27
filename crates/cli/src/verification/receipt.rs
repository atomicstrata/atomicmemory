//! Structured init receipt (human + JSON) aligned with onboarding state machine.

use serde::Serialize;

use crate::cli::{GlobalOptions, OutputFormat};
use crate::environment::dashboard_project_url;
use crate::verification::smoke::SmokeResult;

#[derive(Debug, Clone, Serialize)]
pub struct InitReceipt {
    pub identity_ready: bool,
    pub workspace_ready: bool,
    pub project_ready: bool,
    pub credential_ready: bool,
    pub runtime_ready: bool,
    pub linked: bool,
    pub verified: bool,
    pub activated: bool,
    pub signed_in_as: Option<String>,
    pub workspace_name: String,
    pub workspace_id: String,
    pub project_name: String,
    pub project_id: String,
    pub local_url: String,
    pub core_running: bool,
    pub core_skipped: bool,
    pub cloud_connection_online: bool,
    pub memory_pipeline_verified: bool,
    pub verification_skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_url: Option<String>,
    pub next_command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoke: Option<SmokeResult>,
}

pub struct InitReceiptInput<'a> {
    pub signed_in_as: Option<&'a str>,
    pub org_name: &'a str,
    pub org_id: &'a str,
    pub project_name: &'a str,
    pub project_id: &'a str,
    pub local_url: &'a str,
    pub api_base_url: &'a str,
    pub core_healthy: bool,
    pub no_instance: bool,
    pub cloud_connection_online: bool,
    pub credential_ready: bool,
    pub smoke: Option<SmokeResult>,
}

pub fn build_init_receipt(input: InitReceiptInput<'_>) -> InitReceipt {
    let runtime_ready = input.core_healthy || input.no_instance;
    let pipeline_verified = input.smoke.as_ref().is_some_and(|s| s.verified);
    let verification_skipped = input.smoke.is_none();
    let verified = pipeline_verified;
    let dashboard_url = dashboard_project_url(input.api_base_url, input.project_id);

    InitReceipt {
        identity_ready: true,
        workspace_ready: true,
        project_ready: true,
        credential_ready: input.credential_ready,
        runtime_ready,
        linked: input.cloud_connection_online,
        verified,
        activated: verified,
        signed_in_as: input.signed_in_as.map(str::to_string),
        workspace_name: input.org_name.to_string(),
        workspace_id: input.org_id.to_string(),
        project_name: input.project_name.to_string(),
        project_id: input.project_id.to_string(),
        local_url: input.local_url.to_string(),
        core_running: input.core_healthy,
        core_skipped: input.no_instance,
        cloud_connection_online: input.cloud_connection_online,
        memory_pipeline_verified: pipeline_verified,
        verification_skipped,
        dashboard_url,
        next_command: "am memory ingest \"My preferred editor is Zed\"".into(),
        smoke: input.smoke,
    }
}

pub fn print_init_receipt(receipt: &InitReceipt, global: &GlobalOptions) {
    if global.output == OutputFormat::Json {
        if let Ok(json) = serde_json::to_string_pretty(receipt) {
            println!("{json}");
        }
        return;
    }

    if global.quiet {
        return;
    }

    // Progressive wizard/plain already printed per-step outcomes — footer only.
    if receipt.core_skipped {
        println!(
            "Hint: am instance start  or  am connect --project {}",
            receipt.project_name
        );
    } else if !receipt.core_running {
        println!("Hint: run `am instance status` if ingest fails");
    }
    if !receipt.core_skipped && !receipt.cloud_connection_online {
        println!("Hint: Cloud connection pending — run `am connect doctor`");
    }
    if !receipt.core_skipped && !receipt.memory_pipeline_verified && !receipt.verification_skipped {
        println!("Hint: Memory pipeline not verified — run `am doctor --smoke`");
    }
    if receipt.verification_skipped {
        println!("Hint: Memory pipeline verification was skipped — run `am doctor --smoke`");
    }

    println!();
    if let Some(url) = &receipt.dashboard_url {
        println!("Dashboard: {url}");
    }
    println!("Next: {}", receipt.next_command);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_receipt_is_footer_only() {
        let receipt = build_init_receipt(InitReceiptInput {
            signed_in_as: Some("user@example.com"),
            org_name: "Personal",
            org_id: "org_1",
            project_name: "local",
            project_id: "proj_1",
            local_url: "http://127.0.0.1:17350",
            api_base_url: "https://api.atomicstrata.ai",
            core_healthy: true,
            no_instance: false,
            cloud_connection_online: true,
            credential_ready: true,
            smoke: None,
        });
        assert!(receipt.verification_skipped);
        assert!(!receipt.memory_pipeline_verified);
        assert!(
            receipt
                .dashboard_url
                .as_ref()
                .is_some_and(|url| url.contains("/overview"))
        );
        assert!(receipt.next_command.contains("am memory ingest"));
    }

    #[test]
    fn custom_api_base_url_omits_dashboard_link() {
        let receipt = build_init_receipt(InitReceiptInput {
            signed_in_as: None,
            org_name: "Personal",
            org_id: "org_1",
            project_name: "local",
            project_id: "proj_1",
            local_url: "http://127.0.0.1:17350",
            api_base_url: "https://custom.example.com",
            core_healthy: true,
            no_instance: false,
            cloud_connection_online: true,
            credential_ready: true,
            smoke: None,
        });
        assert!(receipt.dashboard_url.is_none());
    }
}
