//! Post-login org bootstrap — mirrors the web onboarding personal-org default.

use std::io::{self, IsTerminal, Write as _};

use am_cloud_client::{CloudClientError, DashboardClient};
use am_cloud_types::{EnsureOnboardingRequest, Organization};
use anyhow::{Context, Result, bail};

use crate::auth::token::valid_bearer_token;
use crate::config::{resolve_profile, store_project_id};

#[derive(Debug, Clone, Default)]
pub struct EnsureOrgOptions {
    /// Do not persist a default cloud project from onboarding (CLI init creates local instead).
    pub skip_default_project: bool,
}

/// Ensure the session can call org-scoped dashboard APIs.
pub async fn ensure_org_context(
    profile_name: &str,
    org_id: Option<&str>,
    interactive: bool,
    base_url_override: Option<&str>,
    options: EnsureOrgOptions,
) -> Result<Organization> {
    if let Some(id) = org_id {
        let profile = resolve_profile(Some(profile_name), base_url_override, None)?;
        let token = valid_bearer_token(profile_name, &profile.base_url).await?;
        let base = url::Url::parse(&profile.base_url).context("parse base_url")?;
        let client = DashboardClient::new(base, token)?;
        return client.get_org(id).await.map_err(map_org_error);
    }

    let profile = resolve_profile(Some(profile_name), base_url_override, None)?;
    let token = valid_bearer_token(profile_name, &profile.base_url).await?;
    let base = url::Url::parse(&profile.base_url).context("parse base_url")?;
    let client = DashboardClient::new(base, token)?;

    // Prefer list_orgs — works when the JWT carries an active org, and on newer APIs
    // that sync Clerk memberships even without an org claim.
    let orgs = client.list_orgs().await.map_err(map_org_error)?;
    if let Some(org) = pick_org(&orgs, interactive).await? {
        return Ok(org);
    }

    // Bootstrap personal workspace (+ optional default cloud project).
    match client
        .ensure_onboarding(&EnsureOnboardingRequest {
            skip_default_project: options.skip_default_project,
        })
        .await
    {
        Ok(ensured) => {
            if ensured.created_org {
                eprintln!(
                    "Created personal workspace '{}' ({})",
                    ensured.org.name, ensured.org.id
                );
            }
            if !options.skip_default_project
                && let Some(project) = ensured.projects.first()
            {
                store_project_id(profile_name, &project.id)?;
                eprintln!("Default project set to '{}' ({})", project.name, project.id);
            }
            Ok(ensured.org)
        }
        Err(CloudClientError::Status { code: 404, .. }) => {
            bail!(
                "no organization available and org bootstrap is not deployed on {} \
                 (POST /api/onboarding/ensure → 404).\n\
                 • Ensure org bootstrap is deployed on the Cloud API, then re-run `am init`\n\
                 • Or paste a dashboard JWT with an org selected: `am auth login --token <jwt>`\n\
                 • Or finish onboarding at memory.dev, then `am auth login --token <jwt>`",
                profile.base_url
            )
        }
        Err(e) => Err(map_org_error(e)),
    }
}

async fn pick_org(orgs: &[Organization], interactive: bool) -> Result<Option<Organization>> {
    match orgs.len() {
        0 => Ok(None),
        1 => Ok(Some(orgs[0].clone())),
        _ if interactive && io::stdin().is_terminal() => prompt_org(orgs),
        _ => bail!(
            "multiple organizations — re-run with `--org-id` or use `am auth login` after selecting an org in the dashboard"
        ),
    }
}

fn prompt_org(orgs: &[Organization]) -> Result<Option<Organization>> {
    eprintln!();
    eprintln!("Select an organization:");
    for (i, org) in orgs.iter().enumerate() {
        eprintln!("  {}. {} — {} ({})", i + 1, org.name, org.slug, org.id);
    }
    eprintln!();
    let stdin = io::stdin();
    loop {
        eprint!("Enter choice [1-{}] (default 1): ", orgs.len());
        io::stderr().flush().ok();
        let mut line = String::new();
        stdin.read_line(&mut line).context("read org choice")?;
        let choice = line.trim();
        if choice.is_empty() {
            return Ok(Some(orgs[0].clone()));
        }
        let Ok(num) = choice.parse::<usize>() else {
            eprintln!("Enter a number between 1 and {}.", orgs.len());
            continue;
        };
        if (1..=orgs.len()).contains(&num) {
            return Ok(Some(orgs[num - 1].clone()));
        }
        eprintln!("Enter a number between 1 and {}.", orgs.len());
    }
}

fn map_org_error(err: CloudClientError) -> anyhow::Error {
    match err {
        CloudClientError::NoActiveOrganization => anyhow::anyhow!(
            "{err}\nRun `am auth login` (browser OAuth includes org scope) or `am init`."
        ),
        CloudClientError::Auth => anyhow::anyhow!(
            "authentication failed — run `am auth login` or `am init` to refresh your session"
        ),
        other => anyhow::anyhow!("{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn sample_org(id: &str, name: &str) -> Organization {
        Organization {
            id: format!("org_{id}"),
            clerk_org_id: format!("org_clerk_{id}"),
            name: name.into(),
            slug: id.into(),
            created_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn pick_org_auto_selects_single() {
        let orgs = vec![sample_org("solo", "Solo Org")];
        let picked = pick_org(&orgs, true).await.unwrap().unwrap();
        assert_eq!(picked.slug, "solo");
    }
}
