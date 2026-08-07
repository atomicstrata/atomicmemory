//! Authentication: OAuth login, device flow, token storage, and diagnostics.

pub mod auth_wait;
pub mod claims;
pub mod clerk_oauth;
pub mod device_login;
pub mod doctor;
pub mod ensure_org;
pub mod login;
pub mod login_feedback;
pub mod origin;
pub mod pkce;
pub mod setup;
pub mod token;
pub mod token_login;
