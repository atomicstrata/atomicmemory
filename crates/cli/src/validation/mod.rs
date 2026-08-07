//! Fail-closed setup validation and actionable recovery playbooks.

pub mod openai;
pub mod recovery;

pub use openai::{is_repromptable_openai_key_error, validate_openai_api_key};
pub use recovery::with_operation_recovery;
