//! Integration tests for the cloud HTTP client (wiremock).

use am_cloud_client::{DashboardClient, MemoryClient};
use am_core_types::{CoreIngestRequest, CoreSearchRequest};
use url::Url;
use wiremock::matchers::{bearer_token, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn memory_ingest_happy_path() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/memories/ingest"))
        .and(bearer_token("amc_test_key"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "episode_id": "ep_1",
            "memories_stored": 1,
            "stored_memory_ids": ["mem_1"]
        })))
        .mount(&server)
        .await;

    let client = MemoryClient::new(Url::parse(&server.uri()).unwrap(), "amc_test_key").unwrap();
    let resp = client
        .ingest(&CoreIngestRequest {
            user_id: "default".into(),
            source_site: "cli".into(),
            conversation: "hello".into(),
            agent_id: None,
            workspace_id: None,
            session_id: None,
            source_url: None,
            metadata: None,
            skip_extraction: None,
            content_class: None,
            visibility: None,
            config_override: None,
        })
        .await
        .unwrap();
    assert_eq!(resp.episode_id, "ep_1");
}

#[tokio::test]
async fn memory_search_auth_failure() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/memories/search"))
        .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
            "error": "unauthorized"
        })))
        .mount(&server)
        .await;

    let client = MemoryClient::new(Url::parse(&server.uri()).unwrap(), "bad").unwrap();
    let err = client
        .search(&CoreSearchRequest {
            user_id: "default".into(),
            query: "test".into(),
            limit: None,
            threshold: None,
            token_budget: None,
            retrieval_mode: None,
            skip_repair: None,
            source_site: None,
            agent_id: None,
            workspace_id: None,
            session_id: None,
            visibility: None,
            as_of: None,
            namespace_scope: None,
            config_override: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, am_cloud_client::CloudClientError::Auth));
}

#[tokio::test]
async fn dashboard_list_orgs() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/orgs"))
        .and(bearer_token("jwt_test"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "org_1",
                "clerk_org_id": "org_test123",
                "name": "Acme",
                "slug": "acme",
                "created_at": "2026-01-01T00:00:00Z"
            }])),
        )
        .mount(&server)
        .await;

    let client = DashboardClient::new(Url::parse(&server.uri()).unwrap(), "jwt_test").unwrap();
    let orgs = client.list_orgs().await.unwrap();
    assert_eq!(orgs.len(), 1);
    assert_eq!(orgs[0].slug, "acme");
}

#[tokio::test]
async fn memory_mint_local_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/local/token"))
        .and(bearer_token("amc_test_key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "eyJ.test",
            "token_type": "Bearer",
            "expires_in": 300
        })))
        .mount(&server)
        .await;

    let client = MemoryClient::new(Url::parse(&server.uri()).unwrap(), "amc_test_key").unwrap();
    let resp = client.mint_local_token().await.unwrap();
    assert_eq!(resp.access_token, "eyJ.test");
    assert_eq!(resp.expires_in, 300);
}

#[tokio::test]
async fn dashboard_list_runtimes() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/projects/prj_1/runtimes"))
        .and(bearer_token("jwt_test"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "rt_1",
                "project_id": "prj_1",
                "core_instance_id": "core-inst-abc",
                "name": "mac-mini",
                "runtime_type": "local-docker",
                "presence": "online",
                "capabilities": ["memory.read"],
                "core_version": "0.8.2",
                "connector_version": "0.3.0",
                "last_heartbeat_at": "2026-07-13T00:00:00Z",
                "revoked_at": null,
                "created_at": "2026-07-12T00:00:00Z",
                "updated_at": "2026-07-13T00:00:00Z"
            }])),
        )
        .mount(&server)
        .await;

    let client = DashboardClient::new(Url::parse(&server.uri()).unwrap(), "jwt_test").unwrap();
    let runtimes = client.list_runtimes("prj_1").await.unwrap();
    assert_eq!(runtimes.len(), 1);
    assert_eq!(runtimes[0].core_instance_id, "core-inst-abc");
}

/// The Cloud API answers destructive operations with 204 No Content.
///
/// These previously returned `Result<Project>` / `Result<ApiKey>`. An empty body
/// became `serde_json::Value::Null`, failed to deserialize into those types, and
/// the CLI reported failure for a server action that had already succeeded - so
/// an operator saw an error, retried, and hit 404 on an already-deleted
/// resource. Wrong in the worst possible direction for a delete.
#[tokio::test]
async fn delete_project_succeeds_on_204_no_content() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/api/projects/prj_123"))
        .and(bearer_token("amc_test_key"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let client = DashboardClient::new(Url::parse(&server.uri()).unwrap(), "amc_test_key").unwrap();

    client
        .delete_project("prj_123")
        .await
        .expect("204 is success, not a decode failure");
}

#[tokio::test]
async fn revoke_api_key_succeeds_on_204_no_content() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/api/projects/prj_123/api-keys/key_456"))
        .and(bearer_token("amc_test_key"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let client = DashboardClient::new(Url::parse(&server.uri()).unwrap(), "amc_test_key").unwrap();

    client
        .revoke_api_key("prj_123", "key_456")
        .await
        .expect("204 is success, not a decode failure");
}

/// A real error must still surface: the fix discards the BODY, not the status.
#[tokio::test]
async fn delete_project_still_fails_on_error_status() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/api/projects/prj_missing"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "error": "project not found"
        })))
        .mount(&server)
        .await;

    let client = DashboardClient::new(Url::parse(&server.uri()).unwrap(), "amc_test_key").unwrap();

    assert!(
        client.delete_project("prj_missing").await.is_err(),
        "discarding the body must not swallow a failing status",
    );
}
