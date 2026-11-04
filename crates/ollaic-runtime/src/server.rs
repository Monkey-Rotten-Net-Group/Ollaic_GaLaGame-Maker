use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use percent_encoding::percent_decode_str;
use std::{
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, watch, RwLock},
};
use tower_http::services::ServeFile;

#[derive(Clone)]
pub struct RuntimeServer {
    template_dir: Arc<RwLock<PathBuf>>,
    project_dir: Arc<RwLock<Option<PathBuf>>>,
    broadcast_tx: broadcast::Sender<String>,
    shutdown_tx: watch::Sender<bool>,
    ready: Arc<AtomicBool>,
    token: Option<String>,
    port: u16,
}

impl RuntimeServer {
    pub async fn start(template_dir: PathBuf) -> std::io::Result<Self> {
        Self::bind(template_dir, None, None).await
    }

    pub async fn start_preview(template_dir: PathBuf, project: PathBuf) -> std::io::Result<Self> {
        let template = template_dir.canonicalize()?;
        let project = project.canonicalize()?;
        let game = project.join("game").canonicalize()?;
        if !game.starts_with(&project)
            || !game.join("config.txt").is_file()
            || !game.join("scene/start.txt").is_file()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Project needs game/config.txt and game/scene/start.txt",
            ));
        }
        let token = format!("{:032x}", rand::random::<u128>());
        Self::bind(template, Some(project), Some(token)).await
    }

    async fn bind(
        template_dir: PathBuf,
        project: Option<PathBuf>,
        token: Option<String>,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let (broadcast_tx, _) = broadcast::channel(64);
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let server = Self {
            template_dir: Arc::new(RwLock::new(template_dir)),
            project_dir: Arc::new(RwLock::new(project)),
            broadcast_tx,
            shutdown_tx,
            ready: Arc::new(AtomicBool::new(false)),
            token,
            port,
        };
        let router = Router::new()
            .route("/api/webgalsync", any(ws_handler))
            .fallback(static_handler)
            .with_state(server.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.changed().await;
                })
                .await;
        });
        Ok(server)
    }

    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }
    pub fn preview_url(&self) -> String {
        match &self.token {
            Some(token) => format!("{}?ollaicPreview=1&fromStart=1&session={token}", self.url()),
            None => self.url(),
        }
    }
    pub async fn template_dir(&self) -> PathBuf {
        self.template_dir.read().await.clone()
    }
    pub async fn set_template_dir(&self, dir: PathBuf) {
        *self.template_dir.write().await = dir;
    }
    pub async fn set_project(&self, dir: Option<PathBuf>) {
        *self.project_dir.write().await = dir;
    }
    pub fn broadcast(&self, msg: String) {
        let _ = self.broadcast_tx.send(msg);
    }
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }
    pub fn stop(&self) {
        self.ready.store(false, Ordering::Release);
        let _ = self.shutdown_tx.send(true);
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        let Some(token) = &self.token else {
            return true;
        };
        let expected = format!("ollaic_preview_session={token}");
        headers
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(';').any(|cookie| cookie.trim() == expected))
    }

    fn bootstrap_request(&self, uri: &Uri) -> bool {
        self.token.as_ref().is_some_and(|token| {
            matches!(uri.path(), "/" | "/index.html")
                && uri.query().is_some_and(|query| {
                    query
                        .split('&')
                        .any(|part| part == format!("session={token}"))
                })
        })
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(server): State<RuntimeServer>,
    headers: HeaderMap,
) -> Response {
    if !server.authorized(&headers) {
        return (StatusCode::FORBIDDEN, "Preview session required").into_response();
    }
    if server.token.is_some()
        && headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            != Some(server.url().trim_end_matches('/'))
    {
        return (StatusCode::FORBIDDEN, "Unexpected preview origin").into_response();
    }
    let ws = if server.token.is_some() {
        ws.max_message_size(8 * 1024 * 1024)
            .max_frame_size(8 * 1024 * 1024)
    } else {
        ws
    };
    ws.on_upgrade(move |socket| handle_socket(socket, server))
        .into_response()
}

async fn handle_socket(socket: WebSocket, server: RuntimeServer) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = server.broadcast_tx.subscribe();
    let mut outbound_shutdown = server.shutdown_tx.subscribe();
    let outbound = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = outbound_shutdown.changed() => { let _ = sink.close().await; break; }
                message = rx.recv() => match message {
                    Ok(message) => if sink.send(Message::Text(message)).await.is_err() { break; },
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    });
    let mut shutdown = server.shutdown_tx.subscribe();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if serde_json::from_str::<serde_json::Value>(&text).ok()
                        .is_some_and(|value| value["data"]["command"].as_u64() == Some(1)) {
                        server.ready.store(true, Ordering::Release);
                    }
                    let _ = server.broadcast_tx.send(text);
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    server.ready.store(false, Ordering::Release);
    outbound.abort();
}

async fn static_handler(State(server): State<RuntimeServer>, request: Request<Body>) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let bootstrap = server.bootstrap_request(request.uri());
    if !bootstrap && !server.authorized(request.headers()) {
        return (StatusCode::FORBIDDEN, "Preview session required").into_response();
    }
    let decoded = match percent_decode_str(request.uri().path()).decode_utf8() {
        Ok(value) => value.into_owned(),
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let embedded_preview = matches!(decoded.as_str(), "/" | "/index.html")
        && request
            .uri()
            .query()
            .is_some_and(|query| query.split('&').any(|part| part == "ollaicPreview=1"));
    let template = server.template_dir().await;
    let (base, relative) = if let Some(relative) = decoded.strip_prefix("/game/") {
        let Some(project) = server.project_dir.read().await.clone() else {
            return (StatusCode::NOT_FOUND, "No project selected").into_response();
        };
        let project_file = checked_file(&project.join("game"), relative).await;
        let builtin = ["tex/", "template/", "animation/"]
            .iter()
            .any(|prefix| relative.starts_with(prefix))
            || matches!(
                relative,
                "userStyleSheet.css"
                    | "background/WebGAL_New_Enter_Image.webp"
                    | "background/WebGalEnter.webp"
            );
        if project_file.is_none() && builtin && server.token.is_some() {
            (template.join("game"), relative.to_string())
        } else {
            (project.join("game"), relative.to_string())
        }
    } else {
        let relative = decoded.trim_start_matches('/');
        (
            template,
            if relative.is_empty() {
                "index.html"
            } else {
                relative
            }
            .to_string(),
        )
    };
    let Some(file) = checked_file(&base, &relative).await else {
        return (StatusCode::NOT_FOUND, "Preview resource not found").into_response();
    };
    let mut response = if embedded_preview {
        let Ok(metadata) = tokio::fs::metadata(&file).await else {
            return StatusCode::NOT_FOUND.into_response();
        };
        if metadata.len() > 2 * 1024 * 1024 {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        let Ok(html) = tokio::fs::read_to_string(&file).await else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let language = if server.token.is_some() {
            "localStorage.clear();sessionStorage.clear();localStorage.setItem('lang','0')"
        } else {
            "if(!localStorage.getItem('lang'))localStorage.setItem('lang','0')"
        };
        let bootstrap_script = format!("<script>try{{{language}}}catch(e){{}}</script>");
        let html = html.replacen("</head>", &format!("{bootstrap_script}</head>"), 1);
        ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
    } else {
        match ServeFile::new(&file).try_call(request).await {
            Ok(response) => response.map(Body::new),
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if bootstrap {
        if let Some(token) = &server.token {
            let cookie =
                format!("ollaic_preview_session={token}; HttpOnly; SameSite=Strict; Path=/");
            if let Ok(value) = HeaderValue::from_str(&cookie) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
        }
    }
    if server.token.is_some() {
        let policy = format!("default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:{}; object-src 'none'; base-uri 'none'; frame-src 'none'", server.port);
        if let Ok(value) = HeaderValue::from_str(&policy) {
            response
                .headers_mut()
                .insert(header::CONTENT_SECURITY_POLICY, value);
        }
    }
    response
}

async fn checked_file(base: &Path, relative: &str) -> Option<PathBuf> {
    if relative.contains(['\\', '\0'])
        || Path::new(relative)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let base = tokio::fs::canonicalize(base).await.ok()?;
    let file = tokio::fs::canonicalize(base.join(relative)).await.ok()?;
    if !file.starts_with(base) || !tokio::fs::metadata(&file).await.ok()?.is_file() {
        return None;
    }
    Some(file)
}
