use futures_util::{SinkExt, StreamExt};
use ollaic_runtime::server::RuntimeServer;
use reqwest::{header, Client, StatusCode};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

struct Project {
    _directory: tempfile::TempDir,
    engine: PathBuf,
    project: PathBuf,
}

impl Project {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let engine = directory.path().join("engine");
        let project = directory.path().join("project");
        for path in [
            engine.join("assets"),
            engine.join("game/tex"),
            project.join("game/scene"),
            project.join("game/video"),
            project.join(".ollaic"),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(
            engine.join("index.html"),
            "<html><head></head><body>Engine</body></html>",
        )
        .unwrap();
        fs::write(
            engine.join("webgal-engine.json"),
            serde_json::json!({"webgalVersion": ollaic_runtime::engine_version()}).to_string(),
        )
        .unwrap();
        fs::write(engine.join("game/tex/rain.png"), b"builtin").unwrap();
        fs::write(engine.join("game/scene.txt"), b"must not serve demo scenes").unwrap();
        fs::write(project.join("game/config.txt"), b"Game_name:Test;\n").unwrap();
        fs::write(project.join("game/scene/start.txt"), "Alice:Hello;\n").unwrap();
        fs::write(project.join("game/video/test.mp4"), b"0123456789").unwrap();
        fs::write(project.join(".ollaic/private.json"), b"private").unwrap();
        Self {
            _directory: directory,
            engine,
            project,
        }
    }

    async fn start(&self) -> RuntimeServer {
        RuntimeServer::start_preview(self.engine.clone(), self.project.clone())
            .await
            .unwrap()
    }
}

fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}

async fn authenticate(client: &Client, server: &RuntimeServer) -> String {
    let response = client.get(server.preview_url()).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .contains("connect-src 'self' ws://127.0.0.1:"));
    response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn scoped_preview_requires_a_session_and_serves_only_project_game_files() {
    let project = Project::new();
    let server = project.start().await;
    let client = client();
    let url = format!("{}game/scene/start.txt", server.url());
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let cookie = authenticate(&client, &server).await;
    let response = client
        .get(&url)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.text().await.unwrap(), "Alice:Hello;\n");
    for relative in [
        "game/%2e%2e%2f.ollaic/private.json",
        ".ollaic/private.json",
        "game/scene.txt",
    ] {
        assert_eq!(
            client
                .get(format!("{}{relative}", server.url()))
                .header(header::COOKIE, &cookie)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    let builtin = client
        .get(format!("{}game/tex/rain.png", server.url()))
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(builtin.bytes().await.unwrap().as_ref(), b"builtin");
    server.stop();
}

#[tokio::test]
async fn streams_media_ranges_and_encoded_filenames_without_rewriting_project_files() {
    let project = Project::new();
    fs::write(
        project.project.join("game/video/测试 文件.mp4"),
        b"0123456789",
    )
    .unwrap();
    let server = project.start().await;
    let client = client();
    let cookie = authenticate(&client, &server).await;
    let url = format!("{}game/video/测试%20文件.mp4", server.url());
    let response = client
        .get(&url)
        .header(header::COOKIE, &cookie)
        .header(header::RANGE, "bytes=2-5")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"2345");
    let response = client
        .head(&url)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
    assert!(response.bytes().await.unwrap().is_empty());
    assert_eq!(
        fs::read(project.project.join("game/video/测试 文件.mp4")).unwrap(),
        b"0123456789"
    );
    server.stop();
}

#[tokio::test]
async fn preserves_desktop_bootstrap_and_resets_only_preview_browser_storage() {
    let project = Project::new();
    let original = fs::read(project.engine.join("index.html")).unwrap();
    let desktop = RuntimeServer::start(project.engine.clone()).await.unwrap();
    let client = client();
    let html = client
        .get(format!("{}?ollaicPreview=1", desktop.url()))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(html.contains("if(!localStorage.getItem('lang'))"));
    assert!(!html.contains("localStorage.clear()"));
    assert_eq!(
        client
            .get(desktop.url())
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap()
            .as_ref(),
        original
    );
    let preview = project.start().await;
    let html = client
        .get(preview.preview_url())
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(html.contains("localStorage.clear();sessionStorage.clear()"));
    assert_eq!(
        fs::read(project.engine.join("index.html")).unwrap(),
        original
    );
    desktop.stop();
    preview.stop();
}

#[tokio::test]
async fn waits_for_engine_heartbeat_and_releases_the_server_and_websocket() {
    let project = Project::new();
    let server = project.start().await;
    let client = client();
    let cookie = authenticate(&client, &server).await;
    let ws_url = format!("ws://127.0.0.1:{}/api/webgalsync", server.port());
    assert!(connect_async(&ws_url).await.is_err());
    let mut request = ws_url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    request.headers_mut().insert(
        "Origin",
        server.url().trim_end_matches('/').parse().unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    assert!(!server.is_ready());
    socket
        .send(Message::Text(
            r#"{"event":"message","data":{"command":2}}"#.into(),
        ))
        .await
        .unwrap();
    let _ = socket.next().await;
    assert!(!server.is_ready());
    socket
        .send(Message::Text(
            r#"{"event":"message","data":{"command":1}}"#.into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !server.is_ready() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    server.stop();
    assert!(!server.is_ready());
    drop(socket);
    tokio::time::timeout(Duration::from_secs(2), async {
        while tokio::net::TcpStream::connect(("127.0.0.1", server.port()))
            .await
            .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_symbolic_links_outside_game_resources() {
    let project = Project::new();
    std::os::unix::fs::symlink(
        project.project.join(".ollaic/private.json"),
        project.project.join("game/video/private.txt"),
    )
    .unwrap();
    let server = project.start().await;
    let client = client();
    let cookie = authenticate(&client, &server).await;
    assert_eq!(
        client
            .get(format!("{}game/video/private.txt", server.url()))
            .header(header::COOKIE, cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    server.stop();
}

#[test]
fn native_session_starts_pending_and_closes_idempotently() {
    let project = Project::new();
    let mut session =
        ollaic_runtime::session::PreviewSession::start(&project.engine, &project.project).unwrap();
    assert!(!session.is_ready());
    let url = reqwest::Url::parse(&session.url()).unwrap();
    session.close();
    session.close();
    assert!(std::net::TcpStream::connect(("127.0.0.1", url.port().unwrap())).is_err());
}
