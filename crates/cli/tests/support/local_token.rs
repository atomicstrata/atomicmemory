//! Isolated CLI credentials and loopback Cloud/Core contracts for JWT regressions.

#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    routing::any,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

pub const MEMBER: &str = "user_member";
/// Static Core key. Real Core applies no user binding on this branch of
/// `dual-auth.ts`; only Cloud-minted JWTs are bound to `memory_user_id`.
pub const CORE_KEY: &str = "core_managed_fixture";
const KEY_NAME: &str = "connected-local-runtime-a1b2c3d4e5f6";

#[derive(Clone, Debug)]
pub struct Request {
    pub path: String,
    pub body: Value,
    pub user: Option<String>,
    /// Bearer credential the CLI presented.
    pub auth: Option<String>,
}

#[derive(Default)]
pub struct Api {
    pub requests: Vec<Request>,
    pub fail_first_discovery: bool,
    /// `iss` claim on device-flow id_tokens (None omits the claim).
    pub device_iss: Option<String>,
}

pub struct Fixture {
    pub home: tempfile::TempDir,
    pub config: PathBuf,
    pub base: String,
    pub api: Arc<Mutex<Api>>,
    server: tokio::task::JoinHandle<()>,
}

impl Fixture {
    pub async fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let config = if cfg!(target_os = "macos") {
            home.path()
                .join("Library/Application Support/ai.atomicstrata.atomicmemory")
        } else {
            home.path().join("config/atomicmemory")
        };
        fs::create_dir_all(&config).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let api = Arc::new(Mutex::new(Api::default()));
        let app = Router::new()
            .fallback(any(handle))
            .with_state((api.clone(), base.clone()));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let fixture = Self {
            home,
            config,
            base,
            api,
            server,
        };
        fixture.write_config();
        fixture
    }

    fn write_config(&self) {
        fs::write(
            self.config.join("config.toml"),
            format!(
                r#"
default_profile = "local"
cli_key_id = "a1b2c3d4e5f6"
[oauth]
issuer = "{base}"
client_id = "fixture_client"
[profiles.local]
kind = "local"
base_url = "{base}"
local_url = "{base}"
project_id = "proj_test"
api_key_ref = "local"
oauth_ref = "cloud"
"#,
                base = self.base
            ),
        )
        .unwrap();
        fs::write(
            self.config.join("credentials.toml"),
            format!(
                r#"
[oauth.cloud]
id_token = "{token}"
refresh_token = "fixture_refresh"
expires_at = 4102444800
issuer = "{base}"
api_origin = "{base}"
[api_keys.local]
secret = "amc_fixture"
api_origin = "{base}"
project_id = "proj_test"
"#,
                token = token(),
                base = self.base
            ),
        )
        .unwrap();
    }

    pub fn edit(&self, file: &str, change: impl FnOnce(&mut toml::Value)) {
        let path = self.config.join(file);
        let mut value = fs::read_to_string(&path).unwrap().parse().unwrap();
        change(&mut value);
        fs::write(path, toml::to_string(&value).unwrap()).unwrap();
    }

    pub fn command(&self, binary: &Path) -> Command {
        let mut command = Command::new(binary);
        for (name, _) in std::env::vars_os() {
            let key = name.to_string_lossy();
            if key.starts_with("ATOMICMEMORY_")
                || key.starts_with("CORE_")
                || key.starts_with("AM_")
            {
                command.env_remove(name);
            }
        }
        // No Docker binary: exercise the external Core JWT path deterministically.
        command
            .env("HOME", self.home.path())
            .env("XDG_CONFIG_HOME", self.home.path().join("config"))
            .env("XDG_DATA_HOME", self.home.path().join("data"))
            .env("PATH", self.home.path().join("empty-bin"))
            .env("AM_TELEMETRY", "0");
        command
    }

    pub fn run(&self, binary: &Path, args: &[&str], input: Option<&str>) -> Output {
        self.run_with_envs(binary, args, input, &[])
    }

    /// Run with extra env after clearing AtomicMemory/Core overrides.
    ///
    /// Used to force the managed `CORE_API_KEY` HTTP path while keeping the
    /// Connected Local OAuth session on the profile (UTM-2's default).
    pub fn run_with_envs(
        &self,
        binary: &Path,
        args: &[&str],
        input: Option<&str>,
        envs: &[(&str, &str)],
    ) -> Output {
        let mut command = self.command(binary);
        for (key, value) in envs {
            command.env(key, value);
        }
        let mut child = command
            .args(["--no-telemetry", "-o", "json"])
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        child.wait_with_output().unwrap()
    }

    pub fn requests(&self) -> Vec<Request> {
        self.api.lock().unwrap().requests.clone()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn token_with_iss(iss: &str) -> String {
    let payload = format!(r#"{{"sub":"user_member","iss":"{iss}","exp":4102444800}}"#);
    format!("hdr.{}.sig", URL_SAFE_NO_PAD.encode(payload.as_bytes()))
}

fn token() -> String {
    let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"user_member","exp":4102444800}"#);
    format!("hdr.{payload}.sig")
}

async fn handle(
    State((api, base)): State<(Arc<Mutex<Api>>, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    bytes: Bytes,
) -> (StatusCode, Json<Value>) {
    let auth = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string);
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let user = body
        .get("user_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
                .find(|(key, _)| key == "user_id")
                .map(|(_, value)| value.into_owned())
        });
    let path = uri.path();
    let mut api = api.lock().unwrap();
    api.requests.push(Request {
        path: path.into(),
        body: body.clone(),
        user: user.clone(),
        auth: auth.clone(),
    });
    let reply = match path {
        "/.well-known/oauth-authorization-server" => {
            if api.fail_first_discovery {
                api.fail_first_discovery = false;
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"temporary discovery failure"})),
                );
            }
            json!({"authorization_endpoint":format!("{base}/authorize"), "token_endpoint":format!("{base}/oauth/token")})
        }
        "/api/oauth/device/authorize" => json!({
            "device_code":"fixture_device_code",
            "user_code":"FIX-TURE",
            "verification_uri":format!("{base}/activate"),
            "verification_uri_complete":format!("{base}/activate?code=FIX-TURE"),
            "expires_in":600,
            "interval":1
        }),
        "/api/oauth/device/token" => {
            let id_token = api.device_iss.as_deref().map_or_else(token, token_with_iss);
            json!({"id_token":id_token, "refresh_token":"fixture_device_refresh", "token_type":"Bearer", "expires_in":3600})
        }
        "/oauth/token" => {
            json!({"id_token":token(), "refresh_token":"fixture_refresh", "expires_in":3600})
        }
        "/v1/local/token" => {
            if body != json!({"memory_user_id":MEMBER}) {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({"error":"wrong mint identity"})),
                );
            }
            json!({"access_token":token(), "token_type":"Bearer", "expires_in":300})
        }
        "/api/projects/proj_test" => json!({
            "id":"proj_test",
            "org_id":"org_test",
            "name":"Fixture Local",
            "slug":"fixture-local",
            "environment":"production",
            "type":"local",
            "local_url": base,
            "privacy_mode":"connect",
            "created_at":"2026-01-01T00:00:00Z"
        }),
        "/api/projects/proj_test/api-keys" => json!([key()]),
        "/api/projects/proj_test/api-keys/key_existing/rotate" => {
            let mut key = key();
            key["secret"] = "amc_rotated_fixture".into();
            key
        }
        "/v1/memories/health" => json!({"status":"ok"}),
        _ if path.starts_with("/v1/memories") => {
            // Core compares the wire user_id literally with a JWT's
            // memory_user_id; the static key branch applies no binding.
            if auth.as_deref() != Some(CORE_KEY) && user.as_deref() != Some(MEMBER) {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":{"code":"user_binding_mismatch"}})),
                );
            }
            match (method, path) {
                (Method::DELETE, _) => json!({"success":true}),
                (_, "/v1/memories/ingest" | "/v1/memories/ingest/quick") => {
                    json!({"episode_id":"ep_test", "memories_stored":1})
                }
                (_, "/v1/memories/mem_test") => {
                    json!({"id":"mem_test", "content":"fixture memory"})
                }
                _ => json!({"memories":[], "count":0}),
            }
        }
        _ => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error":"unexpected request"})),
            );
        }
    };
    (StatusCode::OK, Json(reply))
}

fn key() -> Value {
    json!({"id":"key_existing", "project_id":"proj_test", "name":KEY_NAME, "prefix":"amc_", "status":"active", "created_at":"2026-01-01T00:00:00Z", "last_used_at":null})
}
