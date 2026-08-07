//! Host MCP integration — detect, install, update, doctor, and uninstall.

pub mod codex_edit;
pub mod detect;
pub mod doctor;
pub mod fingerprint;
pub mod host;
pub mod install;
pub mod path_util;
pub mod spec;
pub mod state;
pub mod write;

pub use detect::{DetectReport, detect_hosts, detected_hosts};
pub use doctor::{DoctorReport, DoctorStatus, doctor_hosts};
pub use host::{Host, InstallScope, PROJECT_SCOPE_UNSUPPORTED, all_hosts, parse_host};
pub use install::{
    InstallAction, InstallReport, install_hosts, select_hosts_interactive, uninstall_hosts,
};
pub use spec::resolve_credentials;
