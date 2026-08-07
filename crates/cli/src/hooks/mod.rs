//! Lifecycle hooks for Codex and Claude Code.

pub mod doctor;
pub mod edit;
pub mod install;
pub mod run;
pub mod sanitize;
mod sanitize_model_blocks;
pub mod types;

pub use doctor::doctor_host;
pub use install::{install_host, uninstall_host};
pub use run::{print_hook_stdout, run_event};
pub use types::{HookEvent, HookHost};
