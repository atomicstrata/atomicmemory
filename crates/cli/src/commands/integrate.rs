//! `am integrate` — detect, install, update, doctor, and uninstall host MCP configs.

use std::io::{self, IsTerminal};

use anyhow::{Result, bail};
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;

use crate::cli::{GlobalOptions, OutputFormat};
use crate::integrate::install::{InstallOptions, default_cwd};
use crate::integrate::spec::preflight_install_runtime;
use crate::integrate::state::list_owned_status;
use crate::integrate::{
    DetectReport, DoctorReport, DoctorStatus, Host, InstallAction, InstallReport, InstallScope,
    PROJECT_SCOPE_UNSUPPORTED, all_hosts, detect_hosts, detected_hosts, doctor_hosts,
    install_hosts, parse_host, resolve_credentials, select_hosts_interactive, uninstall_hosts,
};
use crate::output::{emit, message};
use crate::progress::{ProgressReporter, progress_for};

#[derive(Debug, Args)]
pub struct IntegrateOptions {
    /// Target host (repeatable): cursor, claude-code, codex
    #[arg(long = "host", value_enum, global = true)]
    pub hosts: Vec<HostArg>,

    /// Install into the current project directory (not supported in v1)
    #[arg(long, global = true, hide = true)]
    pub project: bool,

    /// Install into the user home config (default)
    #[arg(long, global = true)]
    pub global: bool,

    /// Overwrite an existing AtomicMemory MCP entry that differs or is unowned
    #[arg(long, global = true)]
    pub force: bool,

    /// Skip prompts; use detected hosts or explicit --host values
    #[arg(short = 'y', long, global = true)]
    pub yes: bool,

    /// Print planned writes without mutating host configs
    #[arg(long, global = true)]
    pub dry_run: bool,

    #[command(subcommand)]
    pub command: Option<IntegrateCommand>,
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
pub enum HostArg {
    Cursor,
    #[value(name = "claude-code")]
    ClaudeCode,
    Codex,
}

impl From<HostArg> for Host {
    fn from(value: HostArg) -> Self {
        match value {
            HostArg::Cursor => Host::Cursor,
            HostArg::ClaudeCode => Host::ClaudeCode,
            HostArg::Codex => Host::Codex,
        }
    }
}

#[derive(Debug, PartialEq, Eq, Subcommand)]
pub enum IntegrateCommand {
    /// List supported hosts and install status
    List,
    /// Report detected hosts without writing configs
    Detect,
    /// Write or refresh AtomicMemory MCP entries
    Install {
        #[arg(value_name = "HOST")]
        positional: Vec<String>,
    },
    /// Refresh MCP entries from the active profile
    Update {
        #[arg(value_name = "HOST")]
        positional: Vec<String>,
    },
    /// Validate installed MCP entries against the active profile
    Doctor {
        #[arg(value_name = "HOST")]
        positional: Vec<String>,
    },
    /// Remove AtomicMemory MCP entries written by this CLI
    Uninstall {
        #[arg(value_name = "HOST")]
        positional: Vec<String>,
    },
}

#[derive(Debug, Serialize)]
struct ListReport {
    supported: Vec<&'static str>,
    detect: DetectReport,
    installs: Vec<OwnedInstallRow>,
}

#[derive(Debug, Serialize)]
struct OwnedInstallRow {
    host: Host,
    config_path: String,
    owned: bool,
    fingerprint_match: bool,
    profile: Option<String>,
}

pub async fn run(opts: IntegrateOptions, global: &GlobalOptions) -> Result<()> {
    ensure_global_scope(&opts)?;
    let cwd = default_cwd()?;
    let scope = InstallScope::Global;
    let detect = if needs_host_detection(&opts) {
        detect_hosts(&cwd)
    } else {
        DetectReport {
            cwd: cwd.display().to_string(),
            hosts: vec![],
        }
    };

    match opts.command {
        Some(IntegrateCommand::List) => return run_list(global, &detect).await,
        Some(IntegrateCommand::Detect) => {
            let detect = filter_detect_report(&detect, &explicit_hosts(&opts));
            return run_detect(global, &detect).await;
        }
        Some(IntegrateCommand::Doctor { ref positional }) => {
            return run_doctor(global, &opts, &cwd, scope, &detect, positional).await;
        }
        Some(IntegrateCommand::Uninstall { ref positional }) => {
            return run_uninstall(global, &opts, &cwd, scope, &detect, positional).await;
        }
        Some(IntegrateCommand::Install { ref positional }) => {
            return run_install(
                global,
                &opts,
                &cwd,
                scope,
                &detect,
                positional,
                InstallAction::Install,
            )
            .await;
        }
        Some(IntegrateCommand::Update { ref positional }) => {
            return run_install(
                global,
                &opts,
                &cwd,
                scope,
                &detect,
                positional,
                InstallAction::Update,
            )
            .await;
        }
        None => {
            return run_install(
                global,
                &opts,
                &cwd,
                scope,
                &detect,
                &[],
                InstallAction::Install,
            )
            .await;
        }
    }
}

fn needs_host_detection(opts: &IntegrateOptions) -> bool {
    opts.command.is_none()
        || matches!(
            opts.command,
            Some(IntegrateCommand::List | IntegrateCommand::Detect)
        )
}

fn explicit_hosts(opts: &IntegrateOptions) -> Vec<Host> {
    opts.hosts.iter().copied().map(Into::into).collect()
}

fn filter_detect_report(report: &DetectReport, hosts: &[Host]) -> DetectReport {
    if hosts.is_empty() {
        return report.clone();
    }
    DetectReport {
        cwd: report.cwd.clone(),
        hosts: report
            .hosts
            .iter()
            .filter(|entry| hosts.contains(&entry.host))
            .cloned()
            .collect(),
    }
}

fn ensure_global_scope(opts: &IntegrateOptions) -> Result<()> {
    if opts.project {
        bail!("{PROJECT_SCOPE_UNSUPPORTED}");
    }
    Ok(())
}

async fn run_list(global: &GlobalOptions, detect: &DetectReport) -> Result<()> {
    let installs = list_owned_status(&all_hosts())?;
    let report = ListReport {
        supported: all_hosts().iter().map(|h| h.id()).collect(),
        detect: detect.clone(),
        installs: installs
            .into_iter()
            .map(|row| OwnedInstallRow {
                host: row.host,
                config_path: row.config_path,
                owned: row.owned,
                fingerprint_match: row.fingerprint_match,
                profile: row.profile,
            })
            .collect(),
    };
    emit(global.output, &report, global.quiet)?;
    Ok(())
}

async fn run_detect(global: &GlobalOptions, detect: &DetectReport) -> Result<()> {
    emit(global.output, detect, global.quiet)?;
    if !global.quiet && global.output != crate::cli::OutputFormat::Json {
        for entry in &detect.hosts {
            let flag = if entry.detected { "yes" } else { "no" };
            message(
                true,
                &format!(
                    "{}: detected={flag} ({})",
                    entry.host.display_name(),
                    entry.signals.join(", ")
                ),
            );
        }
    }
    Ok(())
}

async fn run_install(
    global: &GlobalOptions,
    opts: &IntegrateOptions,
    cwd: &std::path::Path,
    scope: InstallScope,
    detect: &DetectReport,
    positional: &[String],
    action: InstallAction,
) -> Result<()> {
    let mut progress = progress_for(global);
    let params = InstallRunParams {
        global,
        opts,
        cwd,
        scope,
        detect,
        positional,
        action,
    };
    let result = run_install_with_progress(params, progress.as_mut()).await;
    progress.finish();
    result
}

struct InstallRunParams<'a> {
    global: &'a GlobalOptions,
    opts: &'a IntegrateOptions,
    cwd: &'a std::path::Path,
    scope: InstallScope,
    detect: &'a DetectReport,
    positional: &'a [String],
    action: InstallAction,
}

async fn run_install_with_progress(
    params: InstallRunParams<'_>,
    progress: &mut dyn ProgressReporter,
) -> Result<()> {
    progress.start_step("profile", "Resolving profile");
    let creds = resolve_credentials(params.global).await?;
    preflight_install_runtime()?;
    progress.succeed(
        "profile",
        Some(&format!("{:?} @ {}", creds.profile_kind, creds.api_url)),
    );

    progress.start_step("detect", "Selecting hosts");
    // Only pause the spinner when we'll actually prompt on stdin — otherwise
    // `am integrate --host cursor` and `--yes` runs would flicker/blank stderr
    // for a prompt that never happens.
    let will_prompt =
        will_prompt_for_hosts(params.opts, params.positional, io::stdin().is_terminal());
    if will_prompt {
        progress.pause_for_input();
    }
    let hosts = resolve_hosts(params.opts, params.detect, params.positional, true)?;
    if will_prompt {
        progress.resume_after_input();
    }
    progress.succeed(
        "detect",
        Some(
            &hosts
                .iter()
                .map(|h| h.display_name())
                .collect::<Vec<_>>()
                .join(", "),
        ),
    );

    let install_opts = InstallOptions {
        hosts: &hosts,
        scope: params.scope,
        cwd: params.cwd,
        creds: &creds,
        force: params.opts.force,
        dry_run: params.opts.dry_run,
        action: params.action,
    };
    progress.start_step("write", "Writing host MCP configs");
    let report = install_hosts(&install_opts)?;
    finish_install_report(params.global, &report, progress)
}

async fn run_doctor(
    global: &GlobalOptions,
    opts: &IntegrateOptions,
    cwd: &std::path::Path,
    scope: InstallScope,
    detect: &DetectReport,
    positional: &[String],
) -> Result<()> {
    let creds_result = resolve_credentials(global).await;
    let creds = creds_result.as_ref().ok();
    if creds.is_none() && !global.quiet {
        message(
            true,
            "profile unavailable — running structural checks only (npx, config, ownership)",
        );
    }
    let hosts = resolve_hosts(opts, detect, positional, false)?;
    let report = doctor_hosts(&hosts, scope, cwd, creds);
    emit(global.output, &report, global.quiet)?;
    print_doctor_summary(global, &report);
    if report.entries.is_empty() {
        bail!("no host integrations were diagnosed");
    }
    if report.entries.iter().any(|e| e.status != DoctorStatus::Ok) {
        bail!("one or more host integrations need attention");
    }
    creds_result?;
    Ok(())
}

async fn run_uninstall(
    global: &GlobalOptions,
    opts: &IntegrateOptions,
    cwd: &std::path::Path,
    scope: InstallScope,
    detect: &DetectReport,
    positional: &[String],
) -> Result<()> {
    let hosts = resolve_hosts(opts, detect, positional, true)?;
    let report = uninstall_hosts(&hosts, scope, cwd, opts.force, opts.dry_run)?;
    emit(global.output, &report, global.quiet)?;
    for row in &report.results {
        if row.changed {
            message(
                !global.quiet,
                &format!("removed {} from {}", row.host.display_name(), row.path),
            );
        }
    }
    if report.partial_failure {
        bail!("one or more host uninstalls failed — see results");
    }
    Ok(())
}

fn resolve_hosts(
    opts: &IntegrateOptions,
    detect: &DetectReport,
    positional: &[String],
    require_automation_guard: bool,
) -> Result<Vec<Host>> {
    if !positional.is_empty() {
        return positional.iter().map(|s| parse_host(s)).collect();
    }
    if !opts.hosts.is_empty() {
        return Ok(opts.hosts.iter().copied().map(Into::into).collect());
    }
    let is_tty = io::stdin().is_terminal();
    if require_automation_guard && !is_tty && !opts.yes {
        bail!("non-interactive session requires --yes and/or explicit --host");
    }
    let detected = if detect.hosts.is_empty() {
        detected_hosts(&detect_hosts(default_cwd()?.as_path()))
    } else {
        detected_hosts(detect)
    };
    let all = all_hosts().to_vec();
    select_hosts_interactive(&detected, &all, opts.yes, is_tty)
}

fn write_step_outcome(report: &InstallReport) -> WriteStepOutcome {
    if report.partial_failure {
        WriteStepOutcome::Fail
    } else {
        WriteStepOutcome::Success
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteStepOutcome {
    Success,
    Fail,
}

/// Would `resolve_hosts` block on stdin for an interactive host prompt?
///
/// The prompt only fires when the caller passed neither positional hosts nor
/// `--host` flags, is on a TTY, and did not pass `--yes` (which either
/// short-circuits to detected hosts or fails closed on none). This gate keeps
/// `am integrate --host cursor` and `--yes` runs from flickering the spinner
/// or emitting a spurious blank stderr line.
fn will_prompt_for_hosts(
    opts: &IntegrateOptions,
    positional: &[String],
    stdin_is_tty: bool,
) -> bool {
    positional.is_empty() && opts.hosts.is_empty() && !opts.yes && stdin_is_tty
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallOutputMode {
    Json,
    Human,
}

/// Route the install report by `-o` format. JSON stays machine-readable;
/// Table (the default, wizard-friendly) prints the human summary to stdout.
fn install_output_mode(format: OutputFormat) -> InstallOutputMode {
    match format {
        OutputFormat::Json | OutputFormat::Agent => InstallOutputMode::Json,
        OutputFormat::Table => InstallOutputMode::Human,
    }
}

fn finish_install_report(
    global: &GlobalOptions,
    report: &InstallReport,
    progress: &mut dyn ProgressReporter,
) -> Result<()> {
    // Settle the write spinner before emitting the human report so
    // eprintln/println cannot interleave with an active MultiProgress bar.
    match write_step_outcome(report) {
        WriteStepOutcome::Success => progress.succeed("write", None),
        WriteStepOutcome::Fail => progress.fail("write", Some("one or more hosts failed")),
    }
    match install_output_mode(global.output) {
        InstallOutputMode::Json => emit(global.output, report, global.quiet)?,
        InstallOutputMode::Human => print_install_human_report(global, report),
    }
    if !global.quiet && report.results.iter().any(|r| r.changed && !r.dry_run) {
        // Next-step guidance stays on stderr with other operator hints.
        message(
            true,
            "Next: restart your agent host, then run `am integrate doctor`",
        );
    }
    if report.partial_failure {
        bail!("one or more host integrations failed — see results");
    }
    Ok(())
}

/// Print install row summaries to stdout (result channel).
/// Progress/spinners and next-step hints use stderr via `message`.
fn print_install_human_report(global: &GlobalOptions, report: &InstallReport) {
    if global.quiet {
        return;
    }
    for line in render_install_human_lines(report) {
        println!("{line}");
    }
    for row in &report.results {
        if let Some(err) = &row.error {
            // Errors stay on stderr so scripts can separate result vs failure text.
            message(true, &format!("error: {err}"));
        }
    }
}

/// Pure renderer for the human-mode install summary. Returns the lines that
/// would go to stdout — split out so tests can assert the shape without
/// capturing global stdout.
fn render_install_human_lines(report: &InstallReport) -> Vec<String> {
    let mut lines = Vec::with_capacity(report.results.len());
    for row in &report.results {
        if row.changed {
            let verb = if row.dry_run { "would write" } else { "wrote" };
            lines.push(format!(
                "{} {} ({})",
                verb,
                row.host.display_name(),
                row.path
            ));
        } else if let Some(detail) = &row.detail {
            lines.push(detail.clone());
        }
    }
    lines
}

fn print_doctor_summary(global: &GlobalOptions, report: &DoctorReport) {
    if global.quiet {
        return;
    }
    for entry in &report.entries {
        message(
            true,
            &format!(
                "{} [{}]: {:?}{}",
                entry.host.display_name(),
                entry.path,
                entry.status,
                entry
                    .detail
                    .as_ref()
                    .map(|d| format!(" — {d}"))
                    .unwrap_or_default()
            ),
        );
    }
}

#[cfg(test)]
mod parser_tests {
    use super::*;
    use crate::cli::Cli;
    use crate::integrate::detect::HostDetectEntry;
    use clap::Parser;

    fn parse(args: &[&str]) -> IntegrateOptions {
        Cli::try_parse_from(args)
            .expect("parse")
            .command
            .let_integrate()
    }

    trait IntegrateExtract {
        fn let_integrate(self) -> IntegrateOptions;
    }

    impl IntegrateExtract for crate::cli::Command {
        fn let_integrate(self) -> IntegrateOptions {
            match self {
                crate::cli::Command::Integrate(opts) => opts,
                _ => panic!("expected integrate"),
            }
        }
    }

    #[test]
    fn uninstall_accepts_flags_after_subcommand() {
        let opts = parse(&[
            "am",
            "integrate",
            "uninstall",
            "--host",
            "cursor",
            "--dry-run",
        ]);
        assert_eq!(
            opts.command,
            Some(IntegrateCommand::Uninstall { positional: vec![] })
        );
        assert!(opts.dry_run);
        assert_eq!(opts.hosts.len(), 1);
    }

    #[test]
    fn update_accepts_force_after_subcommand() {
        let opts = parse(&["am", "integrate", "update", "--host", "cursor", "--force"]);
        assert!(opts.force);
    }

    #[test]
    fn readme_global_install_parses() {
        let opts = parse(&[
            "am",
            "integrate",
            "--yes",
            "--global",
            "--host",
            "cursor",
            "--host",
            "claude-code",
        ]);
        assert!(opts.yes);
        assert_eq!(opts.hosts.len(), 2);
    }

    #[test]
    fn hidden_project_flag_parses() {
        let opts = parse(&["am", "integrate", "install", "--project"]);
        assert!(opts.project);
    }

    #[test]
    fn project_scope_is_refused_at_runtime() {
        let opts = IntegrateOptions {
            hosts: vec![],
            project: true,
            global: false,
            force: false,
            yes: false,
            dry_run: false,
            command: None,
        };
        let err = ensure_global_scope(&opts).unwrap_err();
        assert!(err.to_string().contains("not supported"));
    }

    #[test]
    fn detect_with_explicit_host_still_runs_and_filters_detection() {
        let opts = parse(&["am", "integrate", "--host", "cursor", "detect"]);
        assert!(needs_host_detection(&opts));

        let report = DetectReport {
            cwd: "/tmp/project".into(),
            hosts: vec![
                HostDetectEntry {
                    host: Host::Cursor,
                    detected: true,
                    signals: vec!["binary `cursor-agent` on PATH".into()],
                },
                HostDetectEntry {
                    host: Host::Codex,
                    detected: true,
                    signals: vec!["binary `codex` on PATH".into()],
                },
            ],
        };
        let filtered = filter_detect_report(&report, &[Host::Cursor]);
        assert_eq!(filtered.hosts.len(), 1);
        assert_eq!(filtered.hosts[0].host, Host::Cursor);
    }

    #[test]
    fn write_step_outcome_reflects_partial_failure() {
        let ok = InstallReport {
            results: vec![],
            partial_failure: false,
        };
        assert_eq!(write_step_outcome(&ok), WriteStepOutcome::Success);
        let fail = InstallReport {
            results: vec![],
            partial_failure: true,
        };
        assert_eq!(write_step_outcome(&fail), WriteStepOutcome::Fail);
    }

    fn opts_with(hosts: Vec<HostArg>, yes: bool) -> IntegrateOptions {
        IntegrateOptions {
            hosts,
            project: false,
            global: true,
            force: false,
            yes,
            dry_run: false,
            command: None,
        }
    }

    #[test]
    fn will_prompt_gate_reflects_hosts_yes_and_tty() {
        // Interactive: no explicit hosts, not --yes, on a TTY -> prompt.
        // This is the case that pauses the spinner; asserting the positive
        // direction is what makes a regressed gate (e.g. one that returns
        // false unconditionally, reintroducing the flicker fix) fail.
        let opts = opts_with(vec![], false);
        assert!(will_prompt_for_hosts(&opts, &[], true));

        // Same inputs but not a TTY: never prompt.
        assert!(!will_prompt_for_hosts(&opts, &[], false));

        // --host cursor short-circuits even on a TTY (no pause/flicker).
        let opts = opts_with(vec![HostArg::Cursor], false);
        assert!(!will_prompt_for_hosts(&opts, &[], true));

        // Positional host argument short-circuits even on a TTY.
        let opts = opts_with(vec![], false);
        assert!(!will_prompt_for_hosts(&opts, &["cursor".to_string()], true));

        // --yes never prompts even on a TTY.
        let opts = opts_with(vec![], true);
        assert!(!will_prompt_for_hosts(&opts, &[], true));
    }

    #[test]
    fn install_output_mode_routes_by_format() {
        assert_eq!(
            install_output_mode(OutputFormat::Json),
            InstallOutputMode::Json
        );
        assert_eq!(
            install_output_mode(OutputFormat::Table),
            InstallOutputMode::Human
        );
    }

    #[test]
    fn render_install_human_lines_covers_wrote_and_would_write() {
        use crate::integrate::install::HostInstallResult;

        let report = InstallReport {
            results: vec![
                HostInstallResult {
                    host: Host::Cursor,
                    scope: InstallScope::Global,
                    path: "/tmp/cursor.mcp.json".into(),
                    action: InstallAction::Install,
                    changed: true,
                    dry_run: false,
                    backup: None,
                    detail: None,
                    error: None,
                },
                HostInstallResult {
                    host: Host::ClaudeCode,
                    scope: InstallScope::Global,
                    path: "/tmp/claude.toml".into(),
                    action: InstallAction::Install,
                    changed: true,
                    dry_run: true,
                    backup: None,
                    detail: None,
                    error: None,
                },
                HostInstallResult {
                    host: Host::Codex,
                    scope: InstallScope::Global,
                    path: "/tmp/codex.toml".into(),
                    action: InstallAction::Install,
                    changed: false,
                    dry_run: false,
                    backup: None,
                    detail: Some("already up to date".into()),
                    error: None,
                },
            ],
            partial_failure: false,
        };
        let lines = render_install_human_lines(&report);
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("wrote "), "got: {}", lines[0]);
        assert!(lines[0].contains("/tmp/cursor.mcp.json"));
        assert!(
            lines[1].starts_with("would write "),
            "dry-run row must say 'would write': {}",
            lines[1]
        );
        assert_eq!(lines[2], "already up to date");
    }
}
