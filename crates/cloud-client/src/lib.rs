//! Typed HTTP clients for the AtomicMemory Cloud gateway.

pub mod client;
pub mod error;
pub mod redact;
pub mod transport;

pub use client::{DashboardClient, MemoryClient, ProjectOverview};
pub use error::CloudClientError;
pub use transport::HttpTransport;
