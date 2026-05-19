use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use percent_encoding::percent_decode_str;
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::{
    net::TcpListener,
    sync::{broadcast, RwLock},
};

#[derive(Clone)]
pub struct RuntimeServer {
    template_dir: Arc<RwLock<PathBuf>>,
    project_dir: Arc<RwLock<Option<PathBuf>>>,
    broadcast_tx: broadcast::Sender<String>,
    port: u16,
}

impl RuntimeServer {
    pub async fn start(template_dir: PathBuf) -> std::io::Result<Self> {
        let (broadcast_tx, _rx) = broadcast::channel::<String>(64);

        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr: SocketAddr = listener.local_addr()?;
        let port = addr.port();

        let server = RuntimeServer {
            template_dir: Arc::new(RwLock::new(template_dir)),
            project_dir: Arc::new(RwLock::new(None)),
            broadcast_tx,
            port,
        };

        let router = Router::new()
            .route("/api/webgalsync", any(ws_handler))
            .fallback(static_handler)
            .with_state(server.clone());

        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                eprintln!("[runtime_server] axum::serve exited: {e}");
            }
        });

        eprintln!("[runtime_server] listening on http://127.0.0.1:{port}");
        Ok(server)
    }

    #[allow(dead_code)]
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
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
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(server): State<RuntimeServer>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, server))
}

async fn handle_socket(socket: WebSocket, server: RuntimeServer) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = server.broadcast_tx.subscribe();
    let tx = server.broadcast_tx.clone();

    let outbound = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sink.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                let _ = tx.send(text);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    outbound.abort();
}

async fn static_handler(State(server): State<RuntimeServer>, uri: Uri) -> Response {
    let raw_path = uri.path();
    let decoded = percent_decode_str(raw_path).decode_utf8_lossy().to_string();

    let (base, rel) = if let Some(stripped) = decoded.strip_prefix("/game/") {
        match server.project_dir.read().await.clone() {
            Some(project) => (project.join("game"), stripped.to_string()),
            None => return not_found("no project set"),
        }
    } else {
        let stripped = decoded.trim_start_matches('/');
        let rel = if stripped.is_empty() {
            "index.html"
        } else {
            stripped
        };
        (server.template_dir.read().await.clone(), rel.to_string())
    };

    serve_file(base, rel).await
}

async fn serve_file(base: PathBuf, rel: String) -> Response {
    let candidate = base.join(&rel);

    let canonical_base = match tokio::fs::canonicalize(&base).await {
        Ok(p) => p,
        Err(_) => return missing_template_response(&base),
    };
    let canonical = match tokio::fs::canonicalize(&candidate).await {
        Ok(p) => p,
        Err(_) => return not_found(&format!("file not found: {}", candidate.display())),
    };
    if !canonical.starts_with(&canonical_base) {
        return forbidden("path escapes base");
    }

    match tokio::fs::read(&canonical).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&canonical)
                .first_or_octet_stream()
                .to_string();
            let mut headers = HeaderMap::new();
            if let Ok(v) = HeaderValue::from_str(&mime) {
                headers.insert(header::CONTENT_TYPE, v);
            }
            // Allow service worker registration scope from root.
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            (StatusCode::OK, headers, bytes).into_response()
        }
        Err(_) => not_found("read failed"),
    }
}

fn not_found(msg: &str) -> Response {
    (StatusCode::NOT_FOUND, msg.to_string()).into_response()
}

fn forbidden(msg: &str) -> Response {
    (StatusCode::FORBIDDEN, msg.to_string()).into_response()
}

fn missing_template_response(base: &PathBuf) -> Response {
    let html = format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WebGAL Template Missing</title>
  <style>
    body {{
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", sans-serif;
      background: linear-gradient(135deg, #10151f, #1d2633);
      color: #eef2f7;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }}
    .card {{
      max-width: 760px;
      width: 100%;
      background: rgba(17, 24, 39, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      padding: 28px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
    }}
    h1 {{ margin: 0 0 12px; font-size: 28px; }}
    p {{ line-height: 1.7; color: #d5dceb; }}
    code {{
      display: block;
      margin: 16px 0;
      padding: 14px 16px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      overflow-wrap: anywhere;
      color: #ffd58a;
    }}
    ol {{ margin: 16px 0 0; padding-left: 20px; line-height: 1.8; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>预览模板缺失</h1>
    <p>当前预览服务器没有找到 WebGAL 运行时模板目录，所以浏览器无法加载预览页面。</p>
    <code>{}</code>
    <ol>
      <li>确认你本机存在 <code>WebGAL_Template</code> 目录。</li>
      <li>在应用设置里选择“预览模板目录”。</li>
      <li>重新点击运行预览。</li>
    </ol>
  </div>
</body>
</html>"#,
        base.display()
    );
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}
