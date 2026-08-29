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
//! 3. **Per-kind Content-Type allowlist.** Image fetches accept `image/*`
//!    only, audio fetches accept `audio/*` only, missing/invalid CT is a
//!    hard reject (we cannot trust a `text/html` or `application/json`
//!    response to actually be a media file).
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
}

/// Per-fetch policy. `total_deadline` covers DNS resolution, connection,
/// every redirect, and the response body — exceeding it for *any* reason
/// aborts the fetch. `allow_address` decides whether a resolved IP is a
/// safe target (loopback / private / reserved are rejected).
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
            let addresses = tokio::time::timeout(
                DNS_RESOLVE_TIMEOUT,
                tokio::net::lookup_host((host, port)),
            )
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
    let mut current = reqwest::Url::parse(initial_url)
        .map_err(|error| format!("无效的下载 URL: {error}"))?;

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

        collect_body(response, policy.kind).await
    }

    unreachable!("redirect loop returns at its configured bound")
}

/// Read a media response body (e.g. from a configured Provider's direct
/// media endpoint) with the same Content-Type and streaming cap guarantees
/// as URL fetches. The provider URL is trusted; only the response shape is
/// validated.
pub async fn collect_media_response(
    response: reqwest::Response,
    kind: MediaKind,
) -> Result<Vec<u8>, String> {
    collect_body(response, kind).await
}

async fn collect_body(
    response: reqwest::Response,
    kind: MediaKind,
) -> Result<Vec<u8>, String> {
    // Reject missing/invalid Content-Type before allocating the buffer.
    // We must know what the endpoint actually returned — a `text/html` or
    // `application/json` response would otherwise be base64-embedded as a
    // "media" file and surface in the user's project as garbage.
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "媒体下载响应缺少 Content-Type 头部".to_string())?;
    let mime = content_type.split(';').next().unwrap_or("").trim();
    if !mime.starts_with(kind.allowed_prefix()) {
        return Err(format!(
            "媒体下载 Content-Type {mime} 不被接受（需要 {}*）",
            kind.allowed_prefix()
        ));
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
            return Err(format!(
                "媒体下载实际大小超过上限 {MAX_MEDIA_BYTES} 字节"
            ));
        }
        collected.extend_from_slice(&chunk);
    }
    Ok(collected)
}

fn validate_download_url(url: &reqwest::Url) -> Result<(), String> {
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

fn is_public_download_ip(ip: IpAddr) -> bool {
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
