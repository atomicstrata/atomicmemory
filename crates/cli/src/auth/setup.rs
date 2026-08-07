//! Post-login bootstrap: pick a default project for the active profile.

use std::io::{self, IsTerminal, Write as _};

use am_cloud_client::DashboardClient;
use am_cloud_types::{Project, preferred_default_project};
use anyhow::{Context, Result};
use url::Url;

use crate::auth::claims::{missing_org_login_hint, token_has_active_org};
use crate::auth::ensure_org::{EnsureOrgOptions, ensure_org_context};
use crate::auth::token::valid_bearer_token;
use crate::config::{resolve_profile, store_project_id};

pub async fn setup_default_project(
    profile_name: &str,
    interactive: bool,
    base_url_override: Option<&str>,
) -> Result<()> {
    let profile = resolve_profile(Some(profile_name), base_url_override, None)?;
    let token = valid_bearer_token(profile_name, &profile.base_url).await?;
    if !token_has_active_org(&token) {
        if interactive {
            ensure_org_context(
                profile_name,
                None,
                true,
                base_url_override,
                EnsureOrgOptions::default(),
            )
            .await?;
        } else {
            eprintln!("{}", missing_org_login_hint());
            eprintln!(
                "Login saved on profile '{profile_name}' — run `am init` or `am project select` after org auth."
            );
            return Ok(());
        }
    }
    let base = Url::parse(&profile.base_url).context("parse base_url")?;
    let client = DashboardClient::new(base, token)?;

    let projects = client.list_projects().await.map_err(|e| match e {
        am_cloud_client::CloudClientError::NoActiveOrganization => {
            anyhow::anyhow!("{e}\n{}", missing_org_login_hint())
        }
        am_cloud_client::CloudClientError::Auth => {
            anyhow::anyhow!("list projects: {e}\n{}", missing_org_login_hint())
        }
        other => anyhow::anyhow!("list projects: {other}"),
    })?;
    let Some(project) = pick_project(&projects, interactive)? else {
        eprintln!(
            "No projects found — create one with `atomicmemory project create`, then run `atomicmemory project select`."
        );
        return Ok(());
    };

    store_project_id(profile_name, &project.id)?;
    eprintln!(
        "Default project set to '{}' ({}) on profile '{profile_name}'.",
        project.name, project.id
    );
    Ok(())
}

fn pick_project(projects: &[Project], interactive: bool) -> Result<Option<&Project>> {
    match projects.len() {
        0 => Ok(None),
        1 => {
            eprintln!(
                "Using project '{}' ({}) — only project in your org.",
                projects[0].name, projects[0].id
            );
            Ok(Some(&projects[0]))
        }
        _ if interactive && io::stdin().is_terminal() => prompt_project(projects),
        _ => Ok(preferred_project(projects)),
    }
}

fn preferred_project(projects: &[Project]) -> Option<&Project> {
    preferred_default_project(projects).or_else(|| projects.first())
}

fn default_project_index(projects: &[Project]) -> usize {
    preferred_default_project(projects)
        .and_then(|preferred| projects.iter().position(|p| p.id == preferred.id))
        .unwrap_or(0)
}

fn prompt_project(projects: &[Project]) -> Result<Option<&Project>> {
    let default_idx = default_project_index(projects);

    eprintln!();
    eprintln!("Select a project for this profile:");
    for (i, project) in projects.iter().enumerate() {
        let marker = if i == default_idx { " (default)" } else { "" };
        eprintln!("  {}. {} — {}{}", i + 1, project.name, project.slug, marker);
    }
    eprintln!();

    let stdin = io::stdin();
    loop {
        eprint!(
            "Enter choice [1-{}] (default {}): ",
            projects.len(),
            default_idx + 1
        );
        io::stderr().flush().ok();
        let mut line = String::new();
        stdin.read_line(&mut line).context("read project choice")?;
        let choice = line.trim();
        if choice.is_empty() {
            return Ok(Some(&projects[default_idx]));
        }
        let Ok(num) = choice.parse::<usize>() else {
            eprintln!("Enter a number between 1 and {}.", projects.len());
            continue;
        };
        if (1..=projects.len()).contains(&num) {
            return Ok(Some(&projects[num - 1]));
        }
        eprintln!("Enter a number between 1 and {}.", projects.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use am_cloud_types::{
        CANONICAL_DEFAULT_PROJECT_SLUG, LEGACY_DEFAULT_PROJECT_SLUG, PrivacyMode, ProjectType,
    };
    use chrono::Utc;

    fn sample_project(slug: &str, name: &str) -> Project {
        Project {
            id: format!("proj_{slug}"),
            org_id: "org_test".into(),
            name: name.into(),
            slug: slug.into(),
            environment: "dev".into(),
            kind: ProjectType::Cloud,
            local_url: None,
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        }
    }

    #[test]
    fn preferred_project_favors_canonical_over_legacy() {
        let projects = vec![
            sample_project("k6-benchmark", "K6 Benchmark"),
            sample_project(LEGACY_DEFAULT_PROJECT_SLUG, "Default Project"),
            sample_project(CANONICAL_DEFAULT_PROJECT_SLUG, "default"),
        ];
        let picked = preferred_project(&projects).unwrap();
        assert_eq!(picked.slug, CANONICAL_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn preferred_project_favors_legacy_default_slug() {
        let projects = vec![
            sample_project("k6-benchmark", "K6 Benchmark"),
            sample_project(LEGACY_DEFAULT_PROJECT_SLUG, "Default Project"),
        ];
        let picked = preferred_project(&projects).unwrap();
        assert_eq!(picked.slug, LEGACY_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn preferred_project_falls_back_to_first_without_defaults() {
        let projects = vec![
            sample_project("alpha", "Alpha"),
            sample_project("beta", "Beta"),
        ];
        let picked = preferred_project(&projects).unwrap();
        assert_eq!(picked.slug, "alpha");
    }

    #[test]
    fn pick_project_auto_selects_single() {
        let projects = vec![sample_project("only-one", "Only One")];
        let picked = pick_project(&projects, true).unwrap().unwrap();
        assert_eq!(picked.slug, "only-one");
    }

    #[test]
    fn pick_project_non_interactive_uses_preferred() {
        let projects = vec![
            sample_project("other", "Other"),
            sample_project(LEGACY_DEFAULT_PROJECT_SLUG, "Default Project"),
        ];
        let picked = pick_project(&projects, false).unwrap().unwrap();
        assert_eq!(picked.slug, LEGACY_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn default_project_index_prefers_canonical() {
        let projects = vec![
            sample_project("other", "Other"),
            sample_project(LEGACY_DEFAULT_PROJECT_SLUG, "Legacy"),
            sample_project(CANONICAL_DEFAULT_PROJECT_SLUG, "default"),
        ];
        assert_eq!(default_project_index(&projects), 2);
    }
}
