//! Loopback file server for self-update tests.
//!
//! Serves the fixture tree over raw HTTP/1.1 so tests do not depend on the
//! public install mirror. A sibling `<file>.redirect` holding a URL answers
//! that path with a `302` to it, so tests can exercise the redirect policy.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// In-process origin whose paths map onto `root`.
pub struct FixtureServer {
    /// `http://127.0.0.1:<port>` with no trailing slash.
    pub base: String,
    hits: Arc<Mutex<Vec<String>>>,
    handle: tokio::task::JoinHandle<()>,
}

impl FixtureServer {
    /// Bind a loopback listener and serve files under `root`.
    pub async fn spawn(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let hits = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&hits);
        let handle = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let root = root.clone();
                let recorded = Arc::clone(&recorded);
                tokio::spawn(serve_one(stream, root, recorded));
            }
        });
        Self {
            base: format!("http://{addr}"),
            hits,
            handle,
        }
    }

    /// Request paths observed so far.
    pub fn hits(&self) -> Vec<String> {
        self.hits.lock().expect("hits").clone()
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn serve_one(mut stream: TcpStream, root: PathBuf, hits: Arc<Mutex<Vec<String>>>) {
    let Some(path) = read_path(&mut stream).await else {
        return;
    };
    if let Ok(mut guard) = hits.lock() {
        guard.push(path.clone());
    }
    if let Some(location) = redirect_target(&root, &path) {
        write_redirect(&mut stream, &location).await;
        return;
    }
    match resolve(&root, &path).and_then(|file| std::fs::read(file).ok()) {
        Some(body) => write_response(&mut stream, 200, "OK", &body).await,
        None => write_response(&mut stream, 404, "Not Found", b"").await,
    }
}

async fn read_path(stream: &mut TcpStream) -> Option<String> {
    let mut buf = vec![0_u8; 4096];
    let mut filled = 0;
    loop {
        if filled == buf.len() {
            return None;
        }
        let read = stream.read(&mut buf[filled..]).await.ok()?;
        if read == 0 {
            return None;
        }
        filled += read;
        if buf[..filled].windows(4).any(|win| win == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf[..filled]);
    let mut parts = text.lines().next()?.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let path = parts.next()?.split('?').next()?;
    Some(path.to_string())
}

async fn write_response(stream: &mut TcpStream, status: u16, reason: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

fn redirect_target(root: &Path, request_path: &str) -> Option<String> {
    let file = resolve(root, &format!("{request_path}.redirect"))?;
    std::fs::read_to_string(file)
        .ok()
        .map(|location| location.trim().to_string())
}

async fn write_redirect(stream: &mut TcpStream, location: &str) {
    let header = format!(
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(header.as_bytes()).await;
}

/// Executable stand-in for `gh` that exits `auth_exit` for `gh auth token` and
/// `verify_exit` for `gh attestation verify`, appending each argv line to
/// `calls.log` beside it.
#[cfg(unix)]
pub fn gh_stub(dir: &Path, auth_exit: u8, verify_exit: u8) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("gh-stub");
    let log = dir.join("calls.log");
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\ncase \"$1\" in\n  auth) exit {auth_exit} ;;\n  attestation) exit {verify_exit} ;;\nesac\nexit 99\n",
        log.display()
    );
    std::fs::write(&path, body).expect("gh stub");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}

/// A `gh` path that does not exist, so tests never reach a real GitHub CLI.
pub const MISSING_GH: &str = "/nonexistent/am-update-test-gh";

fn resolve(root: &Path, request_path: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for part in request_path.trim_start_matches('/').split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        path.push(part);
    }
    path.is_file().then_some(path)
}
