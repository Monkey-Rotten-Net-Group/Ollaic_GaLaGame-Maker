use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn config(provider: &str, base_url: &str, api_key: &str) -> AiConfig {
    AiConfig {
        provider: provider.to_string(),
        model: String::new(),
        models: Vec::new(),
        api_key: api_key.to_string(),
        base_url: base_url.to_string(),
        capabilities: None,
    }
}

/// Serve `responses` in order, one per connection, and hand back each raw
/// request so the test can check the path and headers that were sent.
async fn spawn_server(
    responses: Vec<(&'static str, &'static str)>,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 4096];
            let read = stream.read(&mut buffer).await.unwrap();
            requests.push(String::from_utf8_lossy(&buffer[..read]).to_lowercase());
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).await.unwrap();
            stream.shutdown().await.ok();
        }
        requests
    });
    (base, handle)
}

#[test]
fn openai_candidates_respect_an_existing_version_segment() {
    assert_eq!(
        models_url_candidates(Protocol::OpenAi, "https://api.openai.com/v1/").unwrap(),
        vec!["https://api.openai.com/v1/models"]
    );
    assert_eq!(
        models_url_candidates(Protocol::OpenAi, "https://gateway.test").unwrap(),
        vec![
            "https://gateway.test/v1/models",
            "https://gateway.test/models"
        ]
    );
}

#[test]
fn anthropic_and_gemini_candidates_use_their_own_paths() {
    assert_eq!(
        models_url_candidates(Protocol::Anthropic, "https://api.anthropic.com/v1/").unwrap(),
        vec!["https://api.anthropic.com/v1/models?limit=1000"]
    );
    assert_eq!(
        models_url_candidates(
            Protocol::Gemini,
            "https://generativelanguage.googleapis.com/v1beta/"
        )
        .unwrap(),
        vec!["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"]
    );
}

#[test]
fn auth_headers_follow_the_provider_protocol() {
    let openai = auth_headers(Protocol::OpenAi, "openai-key").unwrap();
    assert_eq!(openai[AUTHORIZATION], "Bearer openai-key");

    let anthropic = auth_headers(Protocol::Anthropic, "anthropic-key").unwrap();
    assert_eq!(anthropic["x-api-key"], "anthropic-key");
    assert_eq!(anthropic["anthropic-version"], ANTHROPIC_VERSION);
    assert!(!anthropic.contains_key(AUTHORIZATION));

    let gemini = auth_headers(Protocol::Gemini, "gemini-key").unwrap();
    assert_eq!(gemini["x-goog-api-key"], "gemini-key");
    assert!(!gemini.contains_key(AUTHORIZATION));
}

#[test]
fn only_chat_models_survive_the_filter() {
    let ids = [
        "gpt-5.5",
        "text-embedding-3-large",
        "whisper-1",
        "gpt-4o-mini-tts",
        "gpt-4o-transcribe",
        "gpt-realtime",
        "gpt-image-2",
        "dall-e-3",
        "omni-moderation-latest",
        "sora-2",
        "grok-imagine-video",
        "gpt-3.5-turbo-instruct",
        "davinci-002",
        "deepseek-flash",
        "gpt-5.5",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(filter_chat_models(ids), vec!["deepseek-flash", "gpt-5.5"]);
}

#[test]
fn gemini_response_keeps_generate_content_models_without_the_prefix() {
    let body = r#"{"models":[
        {"name":"models/gemini-3.5-flash","supportedGenerationMethods":["generateContent","countTokens"]},
        {"name":"models/gemini-embedding-001","supportedGenerationMethods":["embedContent"]},
        {"name":"models/imagen-4.0-generate-001","supportedGenerationMethods":["predict"]},
        {"name":"models/gemini-3-pro-image-preview","supportedGenerationMethods":["generateContent"]}
    ]}"#;
    let ids = filter_chat_models(parse_model_ids(body).unwrap());
    assert_eq!(ids, vec!["gemini-3.5-flash"]);
}

#[tokio::test]
async fn custom_gateway_falls_back_to_models_after_a_404_and_filters_the_result() {
    let (base, server) = spawn_server(vec![
        ("404 Not Found", r#"{"error":"not here"}"#),
        (
            "200 OK",
            r#"{"data":[{"id":"chat-b"},{"id":"text-embedding-x"},{"id":"chat-a"}]}"#,
        ),
    ])
    .await;
    let (endpoint, models) = fetch_chat_models(&config("custom", &base, "gateway-secret"))
        .await
        .unwrap();
    assert_eq!(endpoint, format!("{base}/models"));
    assert_eq!(models, vec!["chat-a", "chat-b"]);

    let requests = server.await.unwrap();
    assert!(requests[0].starts_with("get /v1/models "));
    assert!(requests[1].starts_with("get /models "));
    assert!(requests[1].contains("authorization: bearer gateway-secret"));
}

#[tokio::test]
async fn auth_failure_is_reported_without_leaking_the_key() {
    let (base, server) = spawn_server(vec![(
        "401 Unauthorized",
        r#"{"error":"bad key secret-key-123"}"#,
    )])
    .await;
    let error = fetch_chat_models(&config("custom", &format!("{base}/v1"), "secret-key-123"))
        .await
        .unwrap_err();
    assert!(error.contains("401"), "{error}");
    assert!(!error.contains("secret-key-123"), "{error}");
    server.await.unwrap();
}

#[tokio::test]
async fn missing_inputs_fail_before_any_request() {
    let missing_key = fetch_chat_models(&config("openai", "", ""))
        .await
        .unwrap_err();
    assert!(missing_key.contains("API Key"), "{missing_key}");

    let missing_url = fetch_chat_models(&config("custom", "", ""))
        .await
        .unwrap_err();
    assert!(missing_url.contains("Base URL"), "{missing_url}");

    let media_only = fetch_chat_models(&config("aliyun", "", "key"))
        .await
        .unwrap_err();
    assert!(media_only.contains("不支持在线获取"), "{media_only}");
}
