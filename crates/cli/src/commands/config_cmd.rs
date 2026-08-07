//! `am config` — inspect and edit profiles and resolved settings.

use anyhow::Result;
use clap::Subcommand;
use serde::Serialize;

use crate::auth::clerk_oauth::resolve_oauth_pair;
use crate::cli::GlobalOptions;
use crate::config::{
    ProfileConfig, ProfileKind, apply_environment_preset, load_config, resolve_profile,
    update_config,
};
use crate::environment::{
    BaseUrlInput, CoreImageInput, EffectiveEnvironmentInput, Environment, ValueSource,
    resolve_base_url, resolve_core_image, resolve_effective_environment,
};
use crate::output::{emit, message};

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// Manage environment preset (production)
    Env {
        #[command(subcommand)]
        action: EnvAction,
    },
    /// Set a configuration value
    Set {
        #[command(subcommand)]
        action: SetAction,
    },
    /// Clear a configuration override
    Unset { key: UnsetKey },
    /// List profiles
    Profile {
        #[command(subcommand)]
        action: ProfileAction,
    },
}

#[derive(Debug, Subcommand)]
pub enum EnvAction {
    /// Show the effective environment and resolved defaults
    Show,
    /// Persist an environment preset
    Use { environment: Environment },
}

#[derive(Debug, Subcommand)]
pub enum SetAction {
    /// Override the active profile Cloud API base URL
    BaseUrl { url: String },
    /// Override the default Core Docker image
    CoreImage { image: String },
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum UnsetKey {
    Environment,
    CoreImage,
    BaseUrl,
}

#[derive(Debug, Subcommand)]
pub enum ProfileAction {
    List,
    Show {
        name: Option<String>,
    },
    Use {
        name: String,
    },
    Add {
        name: String,
        #[arg(long)]
        base_url: Option<String>,
        #[arg(long, value_enum)]
        kind: Option<ProfileKindArg>,
        #[arg(long)]
        local_url: Option<String>,
        #[arg(long)]
        project_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum ProfileKindArg {
    Cloud,
    Local,
}

impl From<ProfileKindArg> for ProfileKind {
    fn from(v: ProfileKindArg) -> Self {
        match v {
            ProfileKindArg::Cloud => ProfileKind::Cloud,
            ProfileKindArg::Local => ProfileKind::Local,
        }
    }
}

#[derive(Debug, Serialize)]
struct EnvShowReport {
    environment: Environment,
    environment_source: String,
    base_url: String,
    base_url_source: String,
    core_image: String,
    core_image_source: String,
    /// `None` when this base URL has no usable OAuth configuration, which is
    /// what `am auth login` would report for it.
    oauth_issuer: Option<String>,
    oauth_client_id: Option<String>,
}

pub async fn run(cmd: ConfigCommand, global: &GlobalOptions) -> Result<()> {
    match cmd {
        ConfigCommand::Env { action } => match action {
            EnvAction::Show => {
                let report = build_env_show_report(global)?;
                emit(global.output, &report, global.quiet)
            }
            EnvAction::Use { environment } => {
                update_config(|cfg| {
                    apply_environment_preset(cfg, environment);
                    Ok(())
                })?;
                message(
                    !global.quiet,
                    &format!("Environment preset set to '{environment}'"),
                );
                Ok(())
            }
        },
        ConfigCommand::Set { action } => match action {
            SetAction::BaseUrl { url } => {
                let profile_name = active_profile_name(global)?;
                update_config(|cfg| {
                    let entry = cfg.profiles.entry(profile_name.clone()).or_default();
                    entry.base_url = Some(url);
                    Ok(())
                })?;
                message(
                    !global.quiet,
                    &format!("Profile '{profile_name}' base URL updated"),
                );
                Ok(())
            }
            SetAction::CoreImage { image } => {
                update_config(|cfg| {
                    cfg.core_image = Some(image.clone());
                    Ok(())
                })?;
                message(
                    !global.quiet,
                    &format!("Core image override set to '{image}'"),
                );
                Ok(())
            }
        },
        ConfigCommand::Unset { key } => {
            // Resolved before taking the lock: `active_profile_name` reads the
            // config itself, and the lock is not re-entrant.
            let profile_name = match key {
                UnsetKey::BaseUrl => Some(active_profile_name(global)?),
                _ => None,
            };
            update_config(|cfg| {
                match key {
                    UnsetKey::Environment => cfg.environment = None,
                    UnsetKey::CoreImage => cfg.core_image = None,
                    UnsetKey::BaseUrl => {
                        if let Some(name) = profile_name.as_deref()
                            && let Some(entry) = cfg.profiles.get_mut(name)
                        {
                            entry.base_url = None;
                        }
                    }
                }
                Ok(())
            })?;
            match key {
                UnsetKey::Environment => {
                    message(!global.quiet, "Cleared environment preset override")
                }
                UnsetKey::CoreImage => message(!global.quiet, "Cleared Core image override"),
                UnsetKey::BaseUrl => message(
                    !global.quiet,
                    &format!(
                        "Cleared base URL on profile '{}'",
                        profile_name.as_deref().unwrap_or_default()
                    ),
                ),
            }
            Ok(())
        }
        ConfigCommand::Profile { action } => match action {
            ProfileAction::List => {
                let cfg = load_config()?;
                emit(global.output, &cfg.profiles, global.quiet)
            }
            ProfileAction::Show { name } => {
                let cfg = load_config()?;
                let key = name
                    .or(global.profile.clone())
                    .or(cfg.default_profile.clone())
                    .unwrap_or_else(|| crate::config::DEFAULT_PROFILE.to_string());
                let profile = cfg.profiles.get(&key).cloned().unwrap_or_default();
                emit(global.output, &profile, global.quiet)
            }
            ProfileAction::Use { name } => {
                update_config(|cfg| {
                    cfg.default_profile = Some(name.clone());
                    Ok(())
                })?;
                message(!global.quiet, &format!("Default profile set to '{name}'"));
                Ok(())
            }
            ProfileAction::Add {
                name,
                base_url,
                kind,
                local_url,
                project_id,
            } => {
                let kind = kind.map(ProfileKind::from).unwrap_or(ProfileKind::Cloud);
                update_config(|cfg| {
                    cfg.profiles.insert(
                        name.clone(),
                        ProfileConfig {
                            base_url,
                            kind,
                            local_url,
                            project_id,
                            ..Default::default()
                        },
                    );
                    Ok(())
                })?;
                message(!global.quiet, &format!("Profile '{name}' saved"));
                Ok(())
            }
        },
    }
}

fn active_profile_name(global: &GlobalOptions) -> Result<String> {
    Ok(resolve_profile(
        global.profile.as_deref(),
        global.base_url.as_deref(),
        global.environment,
    )?
    .name)
}

fn build_env_show_report(global: &GlobalOptions) -> Result<EnvShowReport> {
    let cfg = load_config()?;
    let profile = resolve_profile(
        global.profile.as_deref(),
        global.base_url.as_deref(),
        global.environment,
    )?;
    let profile_base = cfg
        .profiles
        .get(&profile.name)
        .and_then(|p| p.base_url.as_deref());

    let env_resolved = resolve_effective_environment(&EffectiveEnvironmentInput {
        environment_override: global.environment,
        base_url_override: global.base_url.as_deref(),
        profile_base_url: profile_base,
        config_environment: cfg.environment,
    });
    let base_resolved = resolve_base_url(&BaseUrlInput {
        base_url_override: global.base_url.as_deref(),
        environment_override: global.environment,
        profile_base_url: profile_base,
        config_environment: cfg.environment,
    });
    let image_resolved = resolve_core_image(&CoreImageInput {
        image_override: std::env::var(crate::config::ENV_CORE_IMAGE).ok().as_deref(),
        config_core_image: cfg.core_image.as_deref(),
    });

    // Report the pair `am auth login` would actually use for this base URL.
    // Deriving these from the environment preset alone printed the production
    // issuer and client_id for custom profiles, where login in fact fails
    // closed demanding explicit OAuth configuration.
    let (oauth_issuer, oauth_client_id) =
        match resolve_oauth_pair(&cfg, &base_resolved.value, None, None) {
            Ok((issuer, client_id)) => (Some(issuer), Some(client_id)),
            Err(_) => (None, None),
        };

    Ok(EnvShowReport {
        environment: env_resolved.value,
        environment_source: format_source(env_resolved.source),
        base_url: base_resolved.value,
        base_url_source: format_source(base_resolved.source),
        core_image: image_resolved.value,
        core_image_source: format_source(image_resolved.source),
        oauth_issuer,
        oauth_client_id,
    })
}

fn format_source(source: ValueSource) -> String {
    match source {
        ValueSource::Flag => "flag".into(),
        ValueSource::Profile => "profile".into(),
        ValueSource::Config => "config".into(),
        ValueSource::BuiltInDefault => "built_in_default".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::{BaseUrlInput, ValueSource, resolve_base_url};

    #[test]
    fn format_source_labels() {
        assert_eq!(
            format_source(ValueSource::BuiltInDefault),
            "built_in_default"
        );
    }

    #[test]
    fn env_show_report_builder_runs_without_panicking() {
        let global = GlobalOptions {
            environment: Some(Environment::Prod),
            output: crate::cli::OutputFormat::Json,
            quiet: true,
            no_telemetry: true,
            ..Default::default()
        };
        let report = build_env_show_report(&global).expect("env show report");
        assert_eq!(report.environment, Environment::Prod);
        assert_eq!(report.base_url, Environment::PROD_BASE_URL);
    }

    #[test]
    fn base_url_precedence_in_report_inputs() {
        let resolved = resolve_base_url(&BaseUrlInput {
            base_url_override: None,
            environment_override: Some(Environment::Prod),
            profile_base_url: Some("https://custom.example.com"),
            config_environment: None,
        });
        assert_eq!(resolved.source, ValueSource::Flag);
        assert_eq!(resolved.value, Environment::PROD_BASE_URL);
    }
}
