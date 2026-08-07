//! Top-level clap definitions.

use clap::{Parser, Subcommand, ValueEnum};

use crate::commands::{
    auth, config_cmd, connect, doctor_cmd, hooks, init, instance, integrate, key, link, memory,
    migrate, org, project, trace, usage,
};
use crate::environment::Environment;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    #[default]
    Table,
    Json,
    Agent,
}

#[derive(Debug, Parser)]
#[command(
    name = "am",
    version,
    about = "AtomicMemory CLI",
    long_about = "Manage hosted AtomicMemory Cloud instances, link local deployments, and run memory operations."
)]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalOptions,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Clone, Parser, Default)]
pub struct GlobalOptions {
    /// Profile to use (Application Support / XDG config dir — see `am config profile list`)
    #[arg(short = 'p', long, env = "ATOMICMEMORY_PROFILE")]
    pub profile: Option<String>,

    /// Override the profile base URL
    #[arg(long, env = "ATOMICMEMORY_API_URL")]
    pub base_url: Option<String>,

    /// Cloud environment preset (production only in the public CLI)
    #[arg(long, value_enum, env = "ATOMICMEMORY_ENV")]
    pub environment: Option<Environment>,

    /// Output format (`json`, `agent`, or table)
    #[arg(short = 'o', long, value_enum, default_value_t = OutputFormat::Table)]
    pub output: OutputFormat,

    /// Emit the stable agent automation envelope (same as `-o agent`)
    #[arg(long, conflicts_with = "output")]
    pub agent: bool,

    /// Scope user id (SDK-aligned)
    #[arg(long, env = "ATOMICMEMORY_SCOPE_USER")]
    pub scope_user: Option<String>,

    /// Scope agent id (SDK-aligned; requires --scope-workspace, must be a UUID)
    #[arg(long, env = "ATOMICMEMORY_SCOPE_AGENT_ID")]
    pub scope_agent_id: Option<String>,

    /// Scope workspace id (requires --scope-agent-id; applies to every `am memory` command)
    #[arg(long, env = "ATOMICMEMORY_SCOPE_WORKSPACE")]
    pub scope_workspace: Option<String>,

    /// Scope namespace
    #[arg(long, env = "ATOMICMEMORY_SCOPE_NAMESPACE")]
    pub scope_namespace: Option<String>,

    /// Scope thread / session id
    #[arg(long, env = "ATOMICMEMORY_SCOPE_THREAD")]
    pub scope_thread: Option<String>,

    /// Suppress non-essential output
    #[arg(short, long)]
    pub quiet: bool,

    /// Increase logging verbosity
    #[arg(short, long, action = clap::ArgAction::Count)]
    pub verbose: u8,

    /// Disable anonymous activation telemetry
    #[arg(long)]
    pub no_telemetry: bool,
}

impl GlobalOptions {
    pub fn agent_output(&self) -> bool {
        self.agent || self.output == OutputFormat::Agent
    }
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// First-run setup: login, org, project, local link, and optional Core instance
    Init(init::InitOptions),
    /// Log in / out and inspect the current session
    #[command(subcommand)]
    Auth(auth::AuthCommand),
    /// Manage connection profiles
    #[command(subcommand)]
    Config(config_cmd::ConfigCommand),
    /// Manage organizations
    #[command(subcommand)]
    Org(org::OrgCommand),
    /// Manage projects (cloud or local)
    #[command(subcommand)]
    Project(project::ProjectCommand),
    /// Manage API keys (amc_ secrets)
    #[command(subcommand)]
    Key(key::KeyCommand),
    /// Ingest, search, list, get, and delete memories
    #[command(subcommand)]
    Memory(memory::MemoryCommand),
    /// Inspect retrieval/mutation traces
    #[command(subcommand)]
    Trace(trace::TraceCommand),
    /// Show usage summary for a project
    Usage(usage::UsageCommand),
    /// Project dashboard overview
    Overview(usage::OverviewCommand),
    /// Check service health
    Health,
    /// Run onboarding health checks (auth, connect wiring, optional smoke)
    Doctor(doctor_cmd::DoctorOptions),
    /// Bind a local Core URL to a Cloud project
    #[command(subcommand)]
    Link(link::LinkCommand),
    /// Configure and verify Core ↔ Cloud sync and local client auth
    Connect(connect::ConnectOptions),
    /// Start/stop the local Core Docker container
    #[command(subcommand)]
    Instance(instance::InstanceCommand),
    /// Export/import local memories to Cloud
    #[command(subcommand)]
    Migrate(migrate::MigrateCommand),
    /// Install AtomicMemory MCP into agent hosts (Cursor, Claude Code, Codex)
    Integrate(integrate::IntegrateOptions),
    /// Lifecycle hooks for Codex and Claude Code (complements `am integrate` MCP)
    #[command(subcommand)]
    Hooks(hooks::HooksCommand),
}

pub fn command_path(command: &Command) -> String {
    match command {
        Command::Init(_) => "init".into(),
        Command::Auth(_) => "auth".into(),
        Command::Config(_) => "config".into(),
        Command::Org(_) => "org".into(),
        Command::Project(_) => "project".into(),
        Command::Key(_) => "key".into(),
        Command::Memory(cmd) => format!("memory {}", memory::command_label(cmd)),
        Command::Trace(_) => "trace".into(),
        Command::Usage(_) => "usage".into(),
        Command::Overview(_) => "overview".into(),
        Command::Health => "health".into(),
        Command::Doctor(_) => "doctor".into(),
        Command::Link(_) => "link".into(),
        Command::Connect(_) => "connect".into(),
        Command::Instance(_) => "instance".into(),
        Command::Migrate(_) => "migrate".into(),
        Command::Integrate(_) => "integrate".into(),
        Command::Hooks(cmd) => format!("hooks {}", hooks::command_label(cmd)),
    }
}
