//! Structured init receipt (human + JSON) aligned with onboarding state machine.

use serde::Serialize;

use crate::cli::{GlobalOptions, OutputFormat};
use crate::environment::dashboard_project_url;
use crate::verification::smoke::SmokeResult;

/// The observed outcome of the verification step, including intentional skips.
#[derive(Debug, Clone)]
pub enum VerificationAttempt {
    /// The smoke completed and returned its evidence.
    Passed(SmokeResult),
    /// An attempted verification failed; retain its actionable error.
    Failed(String),
    /// The user explicitly requested skipping verification or the instance.
    DeliberatelySkipped,
    /// Prerequisites prevented the verification from running.
    NotRun,
}

/// Stable machine-readable verification states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    /// The complete smoke passed.
    Passed,
    /// An attempted smoke failed.
    Failed,
    /// The user explicitly skipped verification.
    DeliberatelySkipped,
    /// Verification did not run because prerequisites were unavailable.
    NotRun,
}

/// Completed onboarding state and the next action for the selected profile.
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
    pub verification_status: VerificationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_url: Option<String>,
    pub next_command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoke: Option<SmokeResult>,
}

/// Explicit observations supplied by the onboarding command boundary.
pub struct InitReceiptInput<'a> {
    pub signed_in_as: Option<&'a str>,
    pub org_name: &'a str,
    pub org_id: &'a str,
    pub project_name: &'a str,
    pub project_id: &'a str,
    pub profile_name: &'a str,
    pub local_url: &'a str,
    pub api_base_url: &'a str,
    pub core_healthy: bool,
    pub no_instance: bool,
    pub cloud_connection_online: bool,
    pub credential_ready: bool,
    pub verification: VerificationAttempt,
}

/// Build a receipt whose activation requires every operational prerequisite.
pub fn build_init_receipt(input: InitReceiptInput<'_>) -> InitReceipt {
    let (verification_status, verification_error, smoke) = match input.verification {
        VerificationAttempt::Passed(smoke) if smoke.verified => {
            (VerificationStatus::Passed, None, Some(smoke))
        }
        VerificationAttempt::Passed(smoke) => (
            VerificationStatus::Failed,
            Some("Memory smoke returned an unverified result".into()),
            Some(smoke),
        ),
        VerificationAttempt::Failed(error) => (VerificationStatus::Failed, Some(error), None),
        VerificationAttempt::DeliberatelySkipped => {
            (VerificationStatus::DeliberatelySkipped, None, None)
        }
        VerificationAttempt::NotRun => (VerificationStatus::NotRun, None, None),
    };
    let verified = verification_status == VerificationStatus::Passed;
    let activated =
        input.credential_ready && input.core_healthy && input.cloud_connection_online && verified;
    let profile = shell_argument(input.profile_name);
    let next_command = if activated {
        format!("am --profile {profile} memory ingest \"My preferred editor is Zed\"")
    } else {
        format!("am --profile {profile} doctor --smoke")
    };

    InitReceipt {
        identity_ready: true,
        workspace_ready: true,
        project_ready: true,
        credential_ready: input.credential_ready,
        runtime_ready: input.core_healthy,
        linked: input.cloud_connection_online,
        verified,
        activated,
        signed_in_as: input.signed_in_as.map(str::to_string),
        workspace_name: input.org_name.to_string(),
        workspace_id: input.org_id.to_string(),
        project_name: input.project_name.to_string(),
        project_id: input.project_id.to_string(),
        local_url: input.local_url.to_string(),
        core_running: input.core_healthy,
        core_skipped: input.no_instance,
        cloud_connection_online: input.cloud_connection_online,
        memory_pipeline_verified: verified,
        verification_skipped: verification_status == VerificationStatus::DeliberatelySkipped,
        verification_status,
        verification_error,
        dashboard_url: dashboard_project_url(input.api_base_url, input.project_id),
        next_command,
        smoke,
    }
}

pub(super) fn shell_argument(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-./".contains(c))
    {
        value.into()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// Render the receipt as JSON or an actionable human-readable footer.
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
    match receipt.verification_status {
        VerificationStatus::Failed => {
            if let Some(error) = &receipt.verification_error {
                println!("Memory pipeline verification failed: {error}");
            }
        }
        VerificationStatus::DeliberatelySkipped => {
            println!("Memory pipeline verification was deliberately skipped.");
        }
        VerificationStatus::NotRun => {
            println!("Memory pipeline verification has not run; prerequisites are incomplete.");
        }
        VerificationStatus::Passed => {}
    }
    if !receipt.core_running {
        println!("Core is not running; start the selected profile's instance.");
    }
    if !receipt.cloud_connection_online {
        println!("Cloud connection is not online; onboarding remains incomplete.");
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

    fn input() -> InitReceiptInput<'static> {
        InitReceiptInput {
            signed_in_as: None,
            org_name: "Personal",
            org_id: "org_1",
            project_name: "local",
            project_id: "proj_1",
            profile_name: "connected-local",
            local_url: "http://127.0.0.1:17350",
            api_base_url: "https://api.atomicstrata.ai",
            core_healthy: true,
            no_instance: false,
            cloud_connection_online: true,
            credential_ready: true,
            verification: VerificationAttempt::Passed(SmokeResult {
                verified: true,
                mode: crate::verification::smoke::SmokeMode::Quick,
                facts_extracted: 0,
                ingest_trace_id: None,
                memory_ids_cleaned: vec![],
                marker: "test".into(),
            }),
        }
    }

    #[test]
    fn activation_requires_credentials_core_and_heartbeat() {
        assert!(build_init_receipt(input()).activated);
        for missing in 0..3 {
            let mut input = input();
            match missing {
                0 => input.credential_ready = false,
                1 => input.core_healthy = false,
                _ => input.cloud_connection_online = false,
            }
            let receipt = build_init_receipt(input);
            assert!(!receipt.activated);
            assert_eq!(
                receipt.next_command,
                "am --profile connected-local doctor --smoke"
            );
        }
    }

    #[test]
    fn absence_of_attempt_is_not_deliberate_skip() {
        let mut input = input();
        input.verification = VerificationAttempt::NotRun;
        let receipt = build_init_receipt(input);
        assert!(!receipt.verification_skipped);
        assert_eq!(receipt.verification_status, VerificationStatus::NotRun);
    }

    #[test]
    fn explicit_skip_is_distinct_from_failure_and_not_run() {
        for (attempt, expected, skipped) in [
            (
                VerificationAttempt::DeliberatelySkipped,
                "deliberately_skipped",
                true,
            ),
            (VerificationAttempt::NotRun, "not_run", false),
            (
                VerificationAttempt::Failed("extraction failed".into()),
                "failed",
                false,
            ),
        ] {
            let mut input = input();
            input.verification = attempt;
            let receipt = build_init_receipt(input);
            let json = serde_json::to_value(&receipt).unwrap();
            assert_eq!(json["verification_status"], expected);
            assert_eq!(receipt.verification_skipped, skipped);
            assert!(!receipt.activated);
            assert!(!receipt.next_command.contains("memory ingest"));
            if expected == "failed" {
                assert_eq!(json["verification_error"], "extraction failed");
            }
        }
    }

    #[test]
    fn skipped_instance_is_not_runtime_ready() {
        let mut input = input();
        input.core_healthy = false;
        input.no_instance = true;
        input.verification = VerificationAttempt::DeliberatelySkipped;
        assert!(!build_init_receipt(input).runtime_ready);
    }

    #[test]
    fn completed_receipt_links_dashboard_and_uses_selected_profile() {
        let receipt = build_init_receipt(input());
        assert!(
            receipt
                .dashboard_url
                .as_ref()
                .unwrap()
                .contains("/overview")
        );
        assert_eq!(receipt.verification_status, VerificationStatus::Passed);
        assert!(
            receipt
                .next_command
                .starts_with("am --profile connected-local memory ingest")
        );
    }

    #[test]
    fn recovery_quotes_profile_names_and_custom_api_omits_dashboard() {
        let mut input = input();
        input.profile_name = "local 'project'";
        input.api_base_url = "https://custom.example.com";
        input.verification = VerificationAttempt::NotRun;
        let receipt = build_init_receipt(input);
        assert!(receipt.dashboard_url.is_none());
        assert_eq!(
            receipt.next_command,
            "am --profile 'local '\\''project'\\''' doctor --smoke"
        );
    }
}
