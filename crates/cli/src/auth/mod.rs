//! Authentication: OAuth login, device flow, token storage, and diagnostics.

#![deny(clippy::disallowed_methods)]

pub mod auth_wait;
pub mod claims;
pub mod clerk_oauth;
pub mod device_login;
pub mod doctor;
pub mod ensure_org;
#[allow(clippy::disallowed_methods)]
pub mod http;
pub mod login;
pub mod login_feedback;
pub mod origin;
pub mod pkce;
pub mod setup;
pub mod token;
pub mod token_login;
