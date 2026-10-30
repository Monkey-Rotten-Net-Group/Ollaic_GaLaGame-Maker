//! Unified safe media fetch — single entry point shared by Provider-returned
//! URL downloads (`download_generated_media`) and direct media responses from
//! configured Provider endpoints. Closing three real risks:
//!
//! 1. **Total deadline.** `FetchPolicy::total_deadline` bounds the *whole*
//!    fetch (DNS resolution, connection, every redirect, and the response
//!    body) instead of letting DNS alone or a body read alone leak past it.
//! 2. **Mixed-DNS rejects.** If the resolver returns *any* private or
//!    reserved address for the host, the whole fetch fails before opening a
//!    socket. Filtering out the bad answer and connecting to a public one
//!    is not acceptable — a resolver bug, a hostile resolver, or DNS
//!    rebinding could still send bytes to the wrong endpoint.
//! 3. **Per-kind Content-Type allowlist, scaled to the trust level.** For a
//!    Provider-returned URL the declared type must positively match the
//!    requested kind — `image/*` for images, `audio/*` for audio — and a
//!    missing or generic type is a hard reject, because a `text/html` or
//!    `application/json` body from an arbitrary host cannot be trusted to be
//!    a media file. For the endpoint the operator configured themselves the
//!    generic binary types that custom gateways actually emit
//!    (`application/octet-stream`, `binary/*`) and an unlabelled body are
//!    accepted, so the documented byte-stream contract keeps working.
//!
//! Plus the existing protections: per-hop URL validation, no-proxy client
//! (so environment proxies cannot bypass the DNS-pinned address), streaming
//! body cap, and DNS pinning via `resolve_to_addrs` so the second TCP
//! lookup cannot return a different address than the one we validated.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::time::Duration;

use futures::TryStreamExt;
use reqwest::header::CONTENT_TYPE;

const MAX_MEDIA_REDIRECTS: usize = 10;
const DNS_RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// Hard cap on a single media download. Provider-generated images rarely
/// exceed ~25 MB and audio clips rarely exceed ~50 MB; anything larger is
/// almost certainly a misconfigured endpoint or an attack, so refuse to
/// allocate the buffer before it lands in memory.
pub const MAX_MEDIA_BYTES: u64 = 64 * 1024 * 1024;

/// What kind of media we are fetching. Decides the Content-Type allowlist
/// so an image endpoint cannot accidentally (or maliciously) hand us HTML
/// or JSON, and an audio endpoint cannot hand us arbitrary executables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Audio,
}

impl MediaKind {
    pub fn allowed_prefix(self) -> &'static str {
        match self {
            MediaKind::Image => "image/",
            MediaKind::Audio => "audio/",
        }
    }

    /// Whether a declared `Content-Type` means "this body *is* the media",
    /// as opposed to a structured envelope we should parse instead. Covers
    /// the exact media type plus the generic byte-stream types that custom
    /// gateways emit when they do not label the payload precisely.
    pub fn declares_media_bytes(self, mime: &str) -> bool {
        let mime = mime.to_ascii_lowercase();
        mime.starts_with(self.allowed_prefix()) || is_generic_binary_type(&mime)
    }
}

/// Types that say "some bytes" rather than naming the media. Accepting them
/// is only safe for an endpoint the operator chose to trust.
fn is_generic_binary_type(mime: &str) -> bool {
    mime == "application/octet-stream" || mime.starts_with("binary/")
}

/// How strictly a media response's declared type is enforced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentTypeCheck {
    /// The declared type must positively match the requested kind. Used for
    /// Provider-returned URLs, which are attacker-influenced.
    Required,
    /// The requested kind, a generic binary type, or no declared type at
    /// all. Used for the endpoint the operator configured themselves.
    ConfiguredEndpoint,
}

/// Per-fetch policy. `total_deadline` covers DNS resolution, connection,
/// every redirect, and the response body — exceeding it for *any* reason
/// aborts the fetch. `allow_address` decides whether a resolved IP is a
/// safe target (loopback / private / reserved are rejected). `kind` also
/// drives the *strict* Content-Type check: on this path a missing or generic
/// type is a rejection, because the URL came from the Provider rather than
/// from the operator.
pub struct FetchPolicy {
    pub total_deadline: Duration,
    pub kind: MediaKind,
    pub allow_address: Box<dyn Fn(&reqwest::Url, IpAddr) -> bool + Send + Sync>,
}

pub trait MediaDnsResolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<SocketAddr>, String>> + Send + 'a>>;
}

pub struct SystemMediaDnsResolver;

impl MediaDnsResolver for SystemMediaDnsResolver {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<SocketAddr>, String>> + Send + 'a>> {
        Box::pin(async move {
            let addresses =
                tokio::time::timeout(DNS_RESOLVE_TIMEOUT, tokio::net::lookup_host((host, port)))
                    .await
                    .map_err(|_| {
                        format!(
                            "媒体下载 DNS 解析 {host} 超时（{} 秒）。请检查网络后重试。",
                            DNS_RESOLVE_TIMEOUT.as_secs()
                        )
                    })?
                    .map_err(|error| {
                        format!("解析媒体下载主机 {host} 失败：{error}。请检查网络后重试。")
                    })?
                    .collect::<Vec<_>>();
            if addresses.is_empty() {
                return Err(format!("媒体下载主机 {host} 没有可用地址，请稍后重试。"));
            }
            Ok(addresses)
        })
    }
}

/// Fetch a media URL following the unified policy. Returns the bytes on
/// success. Any non-public DNS answer rejects the whole fetch; the body is
/// streamed with a hard byte cap; the total deadline covers DNS + connect +
/// redirects + body.
pub async fn fetch_media(
    initial_url: &str,
    resolver: &dyn MediaDnsResolver,
    policy: &FetchPolicy,
) -> Result<Vec<u8>, String> {
    tokio::time::timeout(
        policy.total_deadline,
        fetch_media_inner(initial_url, resolver, policy),
    )
    .await
    .map_err(|_| {
        format!(
            "媒体下载超过总时限 {:?}（涵盖 DNS、连接、重定向和响应体）。",
            policy.total_deadline
        )
    })?
}

async fn fetch_media_inner(
    initial_url: &str,
    resolver: &dyn MediaDnsResolver,
    policy: &FetchPolicy,
) -> Result<Vec<u8>, String> {
    let mut current =
        reqwest::Url::parse(initial_url).map_err(|error| format!("无效的下载 URL: {error}"))?;

    for redirect_count in 0..=MAX_MEDIA_REDIRECTS {
        validate_download_url(&current)?;
        let host = current
            .host_str()
            .ok_or_else(|| "下载 URL 缺少主机名".to_string())?;
        let port = current
            .port_or_known_default()
            .ok_or_else(|| "下载 URL 缺少有效端口".to_string())?;
        let bare_host = host.trim_start_matches('[').trim_end_matches(']');
        let addresses = match bare_host.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => resolver.resolve(host, port).await?,
        };
        // ANY non-public address rejects the entire fetch. Connecting to the
        // public ones anyway opens a TOCTOU window: DNS rebinding, hostile
        // resolver, or a stale record could land us on a private endpoint.
        if let Some(forbidden) = addresses
            .iter()
            .find(|address| !(policy.allow_address)(&current, address.ip()))
        {
            return Err(format!(
                "拒绝下载内部/保留地址: {host} (resolved {})",
                forbidden.ip()
            ));
        }
        let mut pinned = addresses.clone();
        pinned.sort_unstable();
        pinned.dedup();

        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            // Defense-in-depth: even though the outer timeout is the total
            // bound, cap any single request at the same deadline so a stuck
            // socket cannot stall a later body read.
            .timeout(policy.total_deadline);
        if bare_host.parse::<IpAddr>().is_err() {
            builder = builder.resolve_to_addrs(host, &pinned);
        }
        let client = builder
            .build()
            .map_err(|error| format!("创建安全下载客户端失败: {error}"))?;
        let response = client
            .get(current.clone())
            .send()
            .await
            .map_err(|error| format!("下载生成媒体失败: {error}。可稍后重试。"))?;

        if response.status().is_redirection() {
            if redirect_count == MAX_MEDIA_REDIRECTS {
                return Err("媒体下载重定向次数过多，请重试或检查供应商返回地址。".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or_else(|| {
                    "媒体下载返回重定向，但缺少 Location 地址。可稍后重试。".to_string()
                })?
                .to_str()
                .map_err(|_| "媒体下载重定向地址不是有效文本。可稍后重试。".to_string())?;
            current = current
                .join(location)
                .map_err(|error| format!("媒体下载重定向地址无效: {error}"))?;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!(
                "媒体下载失败（HTTP {}）。可稍后重试。",
                response.status()
            ));
        }

        return collect_body(response, policy.kind, ContentTypeCheck::Required).await;
    }

    unreachable!("redirect loop returns at its configured bound")
}

/// Read the body of a direct media response from the endpoint the operator
/// configured, with the same streaming cap as URL fetches.
///
/// The Content-Type check is deliberately looser here than on the
/// Provider-returned URL path: the operator already chose who to talk to,
/// and custom gateways conventionally answer with raw bytes under
/// `application/octet-stream` (or with no type at all), which is the
/// documented byte-stream contract. Anything that is not the expected media
/// kind, a generic binary type, or an unlabelled body is still rejected.
pub async fn collect_media_response(
    response: reqwest::Response,
    kind: MediaKind,
) -> Result<Vec<u8>, String> {
    collect_body(response, kind, ContentTypeCheck::ConfiguredEndpoint).await
}

async fn collect_body(
    response: reqwest::Response,
    kind: MediaKind,
    check: ContentTypeCheck,
) -> Result<Vec<u8>, String> {
    // Check the Content-Type before allocating the buffer. A `text/html` or
    // `application/json` body would otherwise be base64-embedded as a
    // "media" file and surface in the user's project as garbage.
    let declared = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or("").trim())
        .filter(|mime| !mime.is_empty());
    match declared {
        Some(mime) => {
            let accepted = match check {
                ContentTypeCheck::Required => {
                    mime.to_ascii_lowercase().starts_with(kind.allowed_prefix())
                }
                ContentTypeCheck::ConfiguredEndpoint => kind.declares_media_bytes(mime),
            };
            if !accepted {
                return Err(format!(
                    "媒体下载 Content-Type {mime} 不被接受（需要 {}*）",
                    kind.allowed_prefix()
                ));
            }
        }
        None => {
            if check == ContentTypeCheck::Required {
                return Err("媒体下载响应缺少 Content-Type 头部".to_string());
            }
        }
    }
    if let Some(declared) = response.content_length() {
        if declared > MAX_MEDIA_BYTES {
            return Err(format!(
                "媒体下载 Content-Length {declared} 超过上限 {MAX_MEDIA_BYTES} 字节"
            ));
        }
    }
    let mut stream = response.bytes_stream();
    let mut collected = Vec::new();
    let mut received: u64 = 0;
    while let Some(chunk) = stream
        .try_next()
        .await
        .map_err(|error| format!("读取生成媒体失败: {error}。可稍后重试。"))?
    {
        if chunk.len() as u64 > MAX_MEDIA_BYTES {
            return Err(format!(
                "媒体下载单个分块 {} 字节超过上限 {MAX_MEDIA_BYTES}",
                chunk.len()
            ));
        }
        received = received.saturating_add(chunk.len() as u64);
        if received > MAX_MEDIA_BYTES {
            return Err(format!("媒体下载实际大小超过上限 {MAX_MEDIA_BYTES} 字节"));
        }
        collected.extend_from_slice(&chunk);
    }
    Ok(collected)
}

pub(crate) fn validate_download_url(url: &reqwest::Url) -> Result<(), String> {
    match url.scheme() {
        "https" | "http" => {}
        other => return Err(format!("不允许的下载协议: {other}")),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "下载 URL 缺少主机名".to_string())?;
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
        return Err(format!("拒绝下载内部/保留地址: {host}"));
    }
    let bare = lower.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        // Plain IP literals: the per-resolve `allow_address` policy would
        // catch this anyway, but reject early so a hostile caller can't
        // smuggle 127.0.0.1 past the resolver.
        if !is_public_download_ip(ip) {
            return Err(format!("拒绝下载内部/保留地址: {host}"));
        }
    }
    Ok(())
}

pub(crate) fn is_public_download_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 88 && c == 99)
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4() {
                return is_public_download_ip(IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            let globally_allocated = segments[0] & 0xe000 == 0x2000;
            let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
            let benchmarking = segments[0] == 0x2001 && segments[1] == 0x0002;
            let teredo = segments[0] == 0x2001 && segments[1] == 0;
            let orchid = segments[0] == 0x2001 && (0x0010..=0x002f).contains(&segments[1]);
            let six_to_four = segments[0] == 0x2002;
            let documentation_v2 = segments[0] & 0xfff0 == 0x3ff0;
            let segment_routing = segments[0] == 0x5f00;
            globally_allocated
                && !documentation
                && !benchmarking
                && !teredo
                && !orchid
                && !six_to_four
                && !documentation_v2
                && !segment_routing
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct StaticResolver {
        host: String,
        address: SocketAddr,
    }

    impl MediaDnsResolver for StaticResolver {
        fn resolve<'a>(
            &'a self,
            host: &'a str,
            _port: u16,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<SocketAddr>, String>> + Send + 'a>> {
            Box::pin(async move {
                if host == self.host {
                    Ok(vec![self.address])
                } else {
                    Err(format!("unexpected DNS host: {host}"))
                }
            })
        }
    }

    async fn media_response(content_type: Option<&'static str>) -> (String, StaticResolver) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await.unwrap();
            let body = b"media";
            let declared = match content_type {
                Some(value) => format!("Content-Type: {value}\r\n"),
                None => String::new(),
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\n{declared}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(body).await.unwrap();
        });
        (
            format!("http://public-media.test:{}/media", address.port()),
            StaticResolver {
                host: "public-media.test".to_string(),
                address,
            },
        )
    }

    /// Serve one fixed response and hand back a URL for it. `collect_media_response`
    /// does not validate the URL (it validates the *shape* of a response the
    /// operator's own endpoint already returned), so a loopback address is a
    /// faithful stand-in for a configured endpoint.
    async fn configured_endpoint_url(content_type: Option<&'static str>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await.unwrap();
            let body = b"media";
            let declared = match content_type {
                Some(value) => format!("Content-Type: {value}\r\n"),
                None => String::new(),
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\n{declared}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(body).await.unwrap();
        });
        format!("http://127.0.0.1:{}/media", address.port())
    }

    async fn get_without_proxy(url: &str) -> reqwest::Response {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap()
    }

    fn loopback_test_policy(kind: MediaKind) -> FetchPolicy {
        FetchPolicy {
            total_deadline: Duration::from_secs(1),
            kind,
            allow_address: Box::new(|url, ip| {
                url.host_str() == Some("public-media.test") || is_public_download_ip(ip)
            }),
        }
    }

    #[tokio::test]
    async fn fetch_media_accepts_case_insensitive_content_type_for_expected_kind() {
        let (url, resolver) = media_response(Some("Image/PNG")).await;

        let bytes = fetch_media(&url, &resolver, &loopback_test_policy(MediaKind::Image))
            .await
            .unwrap();

        assert_eq!(bytes, b"media");
    }

    #[tokio::test]
    async fn fetch_media_rejects_a_different_media_kind() {
        let (url, resolver) = media_response(Some("Audio/MPEG")).await;

        let error = fetch_media(&url, &resolver, &loopback_test_policy(MediaKind::Image))
            .await
            .unwrap_err();

        assert!(error.contains("Content-Type Audio/MPEG"));
        assert!(error.contains("image/*"));
    }

    #[tokio::test]
    async fn fetch_media_rejects_a_generic_binary_type_from_a_provider_url() {
        // The relaxed rule is scoped to the operator's own endpoint. A URL the
        // Provider handed us must positively declare the media it serves.
        let (url, resolver) = media_response(Some("application/octet-stream")).await;

        let error = fetch_media(&url, &resolver, &loopback_test_policy(MediaKind::Image))
            .await
            .unwrap_err();

        assert!(error.contains("application/octet-stream"), "{error}");
        assert!(error.contains("image/*"), "{error}");
    }

    #[tokio::test]
    async fn fetch_media_rejects_a_provider_response_without_content_type() {
        let (url, resolver) = media_response(None).await;

        let error = fetch_media(&url, &resolver, &loopback_test_policy(MediaKind::Image))
            .await
            .unwrap_err();

        assert!(error.contains("Content-Type"), "{error}");
    }

    #[tokio::test]
    async fn collect_media_response_accepts_the_custom_gateway_byte_stream_contract() {
        // `application/octet-stream` / `binary/*` are what custom gateways
        // actually emit; rejecting them would break a documented contract.
        for content_type in [
            "audio/mpeg",
            "application/octet-stream",
            "binary/octet-stream",
        ] {
            let url = configured_endpoint_url(Some(content_type)).await;
            let response = get_without_proxy(&url).await;

            let bytes = collect_media_response(response, MediaKind::Audio)
                .await
                .unwrap_or_else(|error| panic!("{content_type} was rejected: {error}"));

            assert_eq!(bytes, b"media");
        }
    }

    #[tokio::test]
    async fn collect_media_response_accepts_an_unlabelled_body_from_a_configured_endpoint() {
        let url = configured_endpoint_url(None).await;
        let response = get_without_proxy(&url).await;

        let bytes = collect_media_response(response, MediaKind::Audio)
            .await
            .unwrap();

        assert_eq!(bytes, b"media");
    }

    #[tokio::test]
    async fn collect_media_response_still_rejects_an_unrelated_content_type() {
        let url = configured_endpoint_url(Some("text/html")).await;
        let response = get_without_proxy(&url).await;

        let error = collect_media_response(response, MediaKind::Audio)
            .await
            .unwrap_err();

        assert!(error.contains("Content-Type text/html"), "{error}");
    }
}
