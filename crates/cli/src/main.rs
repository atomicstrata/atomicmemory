//! AtomicMemory CLI — hosted tenancy + memory operations.

mod agent_sanitize;
mod argv_output;
mod auth;
mod cli;
mod commands;
mod config;
mod envelope;
mod environment;
mod hooks;
mod instance;
mod integrate;
mod onboarding_runtime;
mod output;
mod progress;
mod telemetry;
mod validation;
mod verification;

use anyhow::Result;
use clap::Parser;
use cli::{Cli, Command};
use tracing_subscriber::EnvFilter;

/// Default log level for a `-v` count, used when `RUST_LOG` is not set.
fn default_log_level(verbose: u8) -> &'static str {
    match verbose {
        0 => "warn",
        1 => "info",
        2 => "debug",
        _ => "trace",
    }
}

#[tokio::main]
async fn main() {
    let started_at = std::time::Instant::now();
    let argv: Vec<String> = std::env::args().collect();
    let argv_agent = argv_output::detect_argv_agent(&argv);

    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) => {
            if argv_agent {
                let command = argv_output::resolve_command_path_from_argv(&argv);
                let global = cli::GlobalOptions::default();
                let ctx = envelope::EmitContext::new_at(command, &global, started_at);
                let msg = err.to_string();
                let code = output::error_code_for_message(&msg);
                let envelope = envelope::error_envelope(&ctx, code, &msg);
                println!("{}", serde_json::to_string(&envelope).unwrap_or_default());
                std::process::exit(if code == "usage" { 2 } else { 1 });
            }
            err.exit();
        }
    };

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(default_log_level(cli.global.verbose)));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .compact()
        .init();

    let agent_output = cli.global.agent_output();
    let global_for_errors = cli.global.clone();
    let command_for_errors = cli::command_path(&cli.command);

    // Reject agent output for commands with no registered sanitizer BEFORE
    // dispatching. `emit` refuses only at print time, so a command that never
    // reaches it (or mutates first) would run under `--agent` and return raw,
    // unenveloped output — machine consumers cannot distinguish that from a
    // successful envelope.
    if agent_output && !agent_sanitize::supports_agent_output(&command_for_errors) {
        let ctx = envelope::EmitContext::new_at(
            command_for_errors.clone(),
            &global_for_errors,
            started_at,
        );
        let msg = format!(
            "agent output is not supported for command \"{}\" — supported commands: {}",
            command_for_errors,
            agent_sanitize::agent_command_list().join(", ")
        );
        let envelope = envelope::error_envelope(&ctx, "usage", &msg);
        println!("{}", serde_json::to_string(&envelope).unwrap_or_default());
        std::process::exit(2);
    }

    let result = run(cli).await;
    telemetry::flush_telemetry().await;
    if let Err(err) = result {
        if agent_output {
            let ctx =
                envelope::EmitContext::new_at(command_for_errors, &global_for_errors, started_at);
            let msg = format!("{err:#}");
            let code = output::error_code_for_message(&msg);
            let envelope = envelope::error_envelope(&ctx, code, &msg);
            println!("{}", serde_json::to_string(&envelope).unwrap_or_default());
        } else {
            eprintln!("error: {err:#}");
        }
        std::process::exit(output::exit_code_for_error(&err));
    }
}

async fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Init(opts) => commands::init::run(opts, &cli.global).await,
        Command::Auth(cmd) => commands::auth::run(cmd, &cli.global).await,
        Command::Config(cmd) => commands::config_cmd::run(cmd, &cli.global).await,
        Command::Org(cmd) => commands::org::run(cmd, &cli.global).await,
        Command::Project(cmd) => commands::project::run(cmd, &cli.global).await,
        Command::Key(cmd) => commands::key::run(cmd, &cli.global).await,
        Command::Memory(cmd) => commands::memory::run(cmd, &cli.global).await,
        Command::Trace(cmd) => commands::trace::run(cmd, &cli.global).await,
        Command::Usage(cmd) => commands::usage::run(cmd, &cli.global).await,
        Command::Overview(cmd) => commands::usage::run_overview(cmd, &cli.global).await,
        Command::Health => commands::health::run(&cli.global).await,
        Command::Doctor(opts) => commands::doctor_cmd::run(opts, &cli.global).await,
        Command::Link(cmd) => commands::link::run(cmd, &cli.global).await,
        Command::Connect(cmd) => commands::connect::run(cmd, &cli.global).await,
        Command::Instance(cmd) => commands::instance::run(cmd, &cli.global).await,
        Command::Migrate(cmd) => commands::migrate::run(cmd, &cli.global).await,
        Command::Integrate(opts) => commands::integrate::run(opts, &cli.global).await,
        Command::Hooks(cmd) => commands::hooks::run(cmd, &cli.global).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn verbose_flag_raises_the_default_log_level() {
        assert_eq!(default_log_level(0), "warn");
        assert_eq!(default_log_level(1), "info");
        assert_eq!(default_log_level(2), "debug");
        assert_eq!(default_log_level(3), "trace");
    }

    #[test]
    fn version_output_uses_am_identity() {
        let mut cmd = cli::Cli::command();
        cmd.set_bin_name("am");
        let output = cmd.render_version().to_string();
        assert!(
            output.starts_with("am "),
            "expected version banner to start with 'am ', got: {output}"
        );
        assert!(
            output.contains(env!("CARGO_PKG_VERSION")),
            "expected version banner to include workspace version"
        );
    }

    #[test]
    fn agent_parse_error_is_usage_class() {
        let err = Cli::try_parse_from(["am", "--agent", "memory", "search"]).unwrap_err();
        let msg = err.to_string();
        assert_eq!(output::error_code_for_message(&msg), "usage");
    }

    #[test]
    fn registered_agent_commands_cover_memory_and_hooks() {
        let cmds = agent_sanitize::registered_agent_commands();
        assert!(cmds.contains(&"memory search".to_string()));
        assert!(cmds.contains(&"hooks run".to_string()));
        assert!(!cmds.contains(&"config env show".to_string()));
    }

    #[test]
    fn agent_output_support_is_decidable_before_dispatch() {
        // The pre-dispatch gate in `main` uses this: `emit` refuses only at
        // print time, so without it `am --agent config env show` ran the
        // command (mutating state) and returned raw, unenveloped output.
        assert!(agent_sanitize::supports_agent_output("memory search"));
        assert!(agent_sanitize::supports_agent_output("hooks run"));

        // `cli::command_path` yields the top-level name for these, which is
        // exactly what the gate compares.
        for unsupported in ["config", "auth", "key", "project", "instance", "integrate"] {
            assert!(
                !agent_sanitize::supports_agent_output(unsupported),
                "{unsupported} has no sanitizer and must be rejected before dispatch"
            );
        }
        assert!(!agent_sanitize::agent_command_list().is_empty());
    }

    #[test]
    fn every_memory_and_hooks_command_path_supports_agent_output() {
        // The gate keys off `cli::command_path`, so each path it can produce
        // for an agent-capable command must be registered — otherwise a
        // supported command would be rejected (the opposite failure).
        for path in [
            "memory ingest",
            "memory search",
            "memory list",
            "memory get",
            "memory delete",
            "memory package",
            "hooks install",
            "hooks uninstall",
            "hooks doctor",
            "hooks run",
        ] {
            assert!(
                agent_sanitize::supports_agent_output(path),
                "{path} must keep agent support"
            );
        }
    }
}
