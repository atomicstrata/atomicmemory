//! Project DTOs.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::{Validate, ValidationError};

use crate::orgs::SLUG_RE;

/// Canonical default project slug for fresh onboarding.
pub const CANONICAL_DEFAULT_PROJECT_SLUG: &str = "default";
/// Legacy default project slug retained for existing org rows (no migration).
pub const LEGACY_DEFAULT_PROJECT_SLUG: &str = "default-project";
/// Display name paired with [`CANONICAL_DEFAULT_PROJECT_SLUG`] on fresh bootstrap.
pub const CANONICAL_DEFAULT_PROJECT_NAME: &str = "default";

/// Preference rank for default-project slugs (lower = higher priority).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DefaultProjectSlugRank {
    Unrelated = 2,
    Legacy = 1,
    Canonical = 0,
}

impl DefaultProjectSlugRank {
    pub fn for_slug(slug: &str) -> Self {
        match slug {
            CANONICAL_DEFAULT_PROJECT_SLUG => Self::Canonical,
            LEGACY_DEFAULT_PROJECT_SLUG => Self::Legacy,
            _ => Self::Unrelated,
        }
    }
}

pub fn is_default_project_slug(slug: &str) -> bool {
    !matches!(
        DefaultProjectSlugRank::for_slug(slug),
        DefaultProjectSlugRank::Unrelated
    )
}

/// Pick the preferred default project: canonical slug, then legacy, else none.
pub fn preferred_default_project(projects: &[Project]) -> Option<&Project> {
    projects
        .iter()
        .filter(|p| is_default_project_slug(&p.slug))
        .min_by_key(|p| DefaultProjectSlugRank::for_slug(&p.slug))
}

/// Resolve a project ref, treating `default` as canonical-first with legacy fallback.
pub fn find_project_by_default_alias(projects: &[Project]) -> Option<&Project> {
    preferred_default_project(projects)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProjectType {
    Cloud,
    Local,
}

impl ProjectType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cloud => "cloud",
            Self::Local => "local",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PrivacyMode {
    Connect,
    Observe,
    Sync,
}

impl PrivacyMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Observe => "observe",
            Self::Sync => "sync",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Project {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub slug: String,
    pub environment: String,
    #[serde(rename = "type")]
    pub kind: ProjectType,
    pub local_url: Option<String>,
    #[serde(default = "default_privacy_mode")]
    pub privacy_mode: PrivacyMode,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Populated on `GET /api/projects` for cloud projects via core stats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_count: Option<i64>,
    /// Most recent retrieval or mutation trace timestamp for the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate, ToSchema)]
#[validate(schema(function = "validate_project_kind"))]
pub struct CreateProjectRequest {
    pub org_id: String,
    #[validate(length(min = 3, max = 80))]
    pub name: String,
    #[validate(length(min = 1, max = 60), regex(path = *SLUG_RE))]
    pub slug: String,
    #[validate(custom(function = "validate_env"))]
    pub environment: String,
    #[serde(rename = "type", default = "default_project_type")]
    pub kind: ProjectType,
    #[validate(length(max = 2048), url)]
    pub local_url: Option<String>,
}

fn default_project_type() -> ProjectType {
    ProjectType::Cloud
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate, ToSchema)]
pub struct UpdateProjectRequest {
    #[validate(length(min = 3, max = 80))]
    pub name: Option<String>,
    pub privacy_mode: Option<PrivacyMode>,
}

fn default_privacy_mode() -> PrivacyMode {
    PrivacyMode::Connect
}

fn validate_env(value: &str) -> Result<(), ValidationError> {
    match value {
        "dev" | "staging" | "prod" => Ok(()),
        _ => Err(ValidationError::new("invalid_environment")),
    }
}

fn validate_project_kind(req: &CreateProjectRequest) -> Result<(), ValidationError> {
    match (req.kind, req.local_url.as_deref()) {
        (ProjectType::Local, None) | (ProjectType::Local, Some("")) => {
            Err(ValidationError::new("local_url_required_for_local_project"))
        }
        (ProjectType::Cloud, Some(_)) => Err(ValidationError::new(
            "local_url_forbidden_for_cloud_project",
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use validator::Validate;

    fn req(kind: ProjectType, local_url: Option<&str>) -> CreateProjectRequest {
        CreateProjectRequest {
            org_id: "org_test".into(),
            name: "demo".into(),
            slug: "demo".into(),
            environment: "dev".into(),
            kind,
            local_url: local_url.map(str::to_owned),
        }
    }

    #[test]
    fn cloud_without_local_url_is_valid() {
        assert!(req(ProjectType::Cloud, None).validate().is_ok());
    }

    #[test]
    fn local_with_https_url_is_valid() {
        assert!(
            req(ProjectType::Local, Some("https://localhost:7891"))
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn local_without_url_is_rejected() {
        let err = req(ProjectType::Local, None).validate().unwrap_err();
        assert!(format!("{err:?}").contains("local_url_required_for_local_project"));
    }

    #[test]
    fn canonical_slug_ranks_before_legacy() {
        assert!(DefaultProjectSlugRank::Canonical < DefaultProjectSlugRank::Legacy);
        assert_eq!(
            DefaultProjectSlugRank::for_slug(CANONICAL_DEFAULT_PROJECT_SLUG),
            DefaultProjectSlugRank::Canonical
        );
        assert_eq!(
            DefaultProjectSlugRank::for_slug(LEGACY_DEFAULT_PROJECT_SLUG),
            DefaultProjectSlugRank::Legacy
        );
        assert_eq!(
            DefaultProjectSlugRank::for_slug("my-app"),
            DefaultProjectSlugRank::Unrelated
        );
    }

    #[test]
    fn is_default_project_slug_matches_canonical_and_legacy_only() {
        assert!(is_default_project_slug(CANONICAL_DEFAULT_PROJECT_SLUG));
        assert!(is_default_project_slug(LEGACY_DEFAULT_PROJECT_SLUG));
        assert!(!is_default_project_slug("default-project-extra"));
        assert!(!is_default_project_slug("other"));
    }

    #[test]
    fn preferred_default_project_favors_canonical_over_legacy() {
        let projects = vec![
            Project {
                id: "proj_legacy".into(),
                org_id: "org_test".into(),
                name: "Legacy".into(),
                slug: LEGACY_DEFAULT_PROJECT_SLUG.into(),
                environment: "dev".into(),
                kind: ProjectType::Cloud,
                local_url: None,
                privacy_mode: PrivacyMode::Connect,
                created_at: Utc::now(),
                memory_count: None,
                last_activity_at: None,
            },
            Project {
                id: "proj_canonical".into(),
                org_id: "org_test".into(),
                name: CANONICAL_DEFAULT_PROJECT_NAME.into(),
                slug: CANONICAL_DEFAULT_PROJECT_SLUG.into(),
                environment: "dev".into(),
                kind: ProjectType::Cloud,
                local_url: None,
                privacy_mode: PrivacyMode::Connect,
                created_at: Utc::now(),
                memory_count: None,
                last_activity_at: None,
            },
        ];
        let picked = preferred_default_project(&projects).unwrap();
        assert_eq!(picked.slug, CANONICAL_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn preferred_default_project_falls_back_to_legacy() {
        let projects = vec![Project {
            id: "proj_legacy".into(),
            org_id: "org_test".into(),
            name: "Default Project".into(),
            slug: LEGACY_DEFAULT_PROJECT_SLUG.into(),
            environment: "dev".into(),
            kind: ProjectType::Cloud,
            local_url: None,
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        }];
        let picked = preferred_default_project(&projects).unwrap();
        assert_eq!(picked.slug, LEGACY_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn preferred_default_project_returns_none_without_defaults() {
        let projects = vec![Project {
            id: "proj_other".into(),
            org_id: "org_test".into(),
            name: "Other".into(),
            slug: "other".into(),
            environment: "dev".into(),
            kind: ProjectType::Cloud,
            local_url: None,
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        }];
        assert!(preferred_default_project(&projects).is_none());
    }
}
