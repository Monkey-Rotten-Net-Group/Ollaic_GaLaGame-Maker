//! MiniMax image protocol. Subscription and pay-as-you-go keys use the same
//! endpoint; the configured bearer key determines which resources are consumed.

use base64::Engine;
use serde::Deserialize;

use crate::ai::config::AiProviderConfig;
use crate::ai::gateway::transport::{media_endpoint, post_json_text};
use crate::ai::gateway::types::{strip_data_url_prefix, GeneratedMedia, ImageRequest};
use crate::ai::media_support::log_provider_event;
use crate::ai::registry::Modality;
use crate::ai::safe_media_fetch::MAX_MEDIA_BYTES;

const MAX_REFERENCE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Deserialize)]
struct ImageResponse {
    base_resp: BaseResponse,
    data: Option<ImageData>,
}

#[derive(Deserialize)]
struct BaseResponse {
    status_code: i64,
}

#[derive(Deserialize)]
struct ImageData {
    #[serde(default)]
    image_base64: Vec<String>,
}

fn image_request_body(request: &ImageRequest<'_>) -> Result<serde_json::Value, String> {
    if request.prompt.chars().count() > 1500 {
        return Err("MiniMax 图片描述不能超过 1500 字符".into());
    }
    let ratio = request.aspect_ratio.unwrap_or("1:1");
    if !matches!(
        ratio,
        "1:1" | "16:9" | "4:3" | "3:2" | "2:3" | "3:4" | "9:16" | "21:9"
    ) {
        return Err(format!("MiniMax 不支持图片比例 {ratio}"));
    }
    let mut body = serde_json::json!({
        "model": request.model,
        "prompt": request.prompt,
        "aspect_ratio": ratio,
        "response_format": "base64",
        "n": 1,
    });
    if let Some(reference) = request.reference {
        let converted;
        let reference = if reference.mime == "image/webp" {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&reference.base64)
                .map_err(|_| "MiniMax 人物参考图 base64 无效")?;
            if bytes.len() >= MAX_REFERENCE_BYTES {
                return Err("MiniMax 人物参考图必须小于 10 MB".into());
            }
            let image = image::load_from_memory(&bytes).map_err(|_| "MiniMax 人物参考图无效")?;
            let mut png = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut png, image::ImageFormat::Png)
                .map_err(|_| "参考图 PNG 转换失败")?;
            converted = crate::ai::gateway::types::ImageReference {
                mime: "image/png".into(),
                base64: base64::engine::general_purpose::STANDARD.encode(png.into_inner()),
            };
            &converted
        } else {
            reference
        };
        if !matches!(reference.mime.as_str(), "image/jpeg" | "image/png") {
            return Err("MiniMax 人物参考图仅支持 JPEG 或 PNG".into());
        }
        if reference.base64.len() > MAX_REFERENCE_BYTES.div_ceil(3) * 4 {
            return Err("MiniMax 人物参考图必须小于 10 MB".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&reference.base64)
            .map_err(|_| "MiniMax 人物参考图 base64 无效")?;
        if bytes.is_empty() || bytes.len() >= MAX_REFERENCE_BYTES {
            return Err("MiniMax 人物参考图必须非空且小于 10 MB".into());
        }
        body["subject_reference"] = serde_json::json!([{
            "type": "character",
            "image_file": reference.data_url(),
        }]);
    }
    Ok(body)
}

fn parse_image_response(text: &str) -> Result<GeneratedMedia, String> {
    // Do not include the response body in errors: it can contain image data or
    // provider diagnostics that echo credentials and other private request data.
    let parsed: ImageResponse =
        serde_json::from_str(text).map_err(|_| "MiniMax 图片响应格式无效".to_string())?;
    let code = parsed.base_resp.status_code;
    if code != 0 {
        let reason = match code {
            1002 => "请求限流，请稍后重试",
            1004 | 2049 => "鉴权失败，请检查 API Key 与国内站/国际站地址是否匹配",
            1008 => "可用额度不足，请检查套餐用量或账户余额",
            1026 => "图片描述未通过内容审核",
            2013 => "请求参数无效，请检查模型、描述与参考图",
            _ => "请在 MiniMax 控制台检查请求与套餐状态",
        };
        return Err(format!("MiniMax 图片生成失败 ({code}): {reason}"));
    }
    let image = parsed
        .data
        .and_then(|data| data.image_base64.into_iter().next())
        .filter(|value| !value.trim().is_empty())
        .ok_or("MiniMax 未返回图片，图片可能未通过内容审核")?;
    let image = strip_data_url_prefix(&image);
    if image.len() as u64 > MAX_MEDIA_BYTES.div_ceil(3) * 4 {
        return Err("MiniMax 图片超过大小上限".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image)
        .map_err(|_| "MiniMax 图片 base64 无效")?;
    if bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err("MiniMax 图片超过大小上限".into());
    }
    let format = image::guess_format(&bytes).map_err(|_| "MiniMax 返回了无效或不支持的图片格式")?;
    let extension = match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::WebP => "webp",
        _ => return Err("MiniMax 返回了无效或不支持的图片格式".into()),
    };
    // Signatures alone also match truncated files. Decode before publishing an
    // asset, with limits on both the decoded dimensions and memory allocation.
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_MEDIA_BYTES);
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "MiniMax 图片已损坏或超出解码大小上限")?;
    Ok(GeneratedMedia {
        base64_data: image.to_string(),
        extension: extension.to_string(),
    })
}

pub async fn generate_image(
    cfg: &AiProviderConfig,
    request: &ImageRequest<'_>,
) -> Result<GeneratedMedia, String> {
    let body = image_request_body(request)?;
    let endpoint = media_endpoint(cfg, Modality::Image, "image_generation");
    let text = post_json_text(cfg, &endpoint, body, "MiniMax 图片生成").await?;
    // Image decoding is CPU work and must not block the async executor.
    let result = tokio::task::spawn_blocking(move || parse_image_response(&text))
        .await
        .map_err(|_| "MiniMax 图片解码任务失败".to_string())
        .and_then(|result| result);
    log_provider_event(
        "image_generate",
        cfg,
        request.model,
        &endpoint,
        result.is_ok(),
        result
            .as_ref()
            .err()
            .map_or("image generated", String::as_str),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::gateway::adaptors::{adaptor_for, MediaAdaptor};
    use crate::ai::gateway::types::ImageReference;

    fn request() -> ImageRequest<'static> {
        ImageRequest {
            model: "image-01",
            prompt: "a quiet school courtyard",
            reference: None,
            aspect_ratio: Some("16:9"),
        }
    }

    fn encoded_image(format: image::ImageFormat) -> String {
        let image = image::DynamicImage::new_rgb8(1, 1);
        let mut output = std::io::Cursor::new(Vec::new());
        image.write_to(&mut output, format).unwrap();
        base64::engine::general_purpose::STANDARD.encode(output.into_inner())
    }

    fn response(image: &str) -> String {
        serde_json::json!({
            "base_resp": { "status_code": 0, "status_msg": "success" },
            "data": { "image_base64": [image] },
        })
        .to_string()
    }

    #[test]
    fn request_preserves_character_reference_and_canvas() {
        let reference = ImageReference {
            mime: "image/png".into(),
            base64: encoded_image(image::ImageFormat::Png),
        };
        let body = image_request_body(&ImageRequest {
            reference: Some(&reference),
            aspect_ratio: Some("3:4"),
            ..request()
        })
        .unwrap();
        assert_eq!(body["subject_reference"][0]["type"], "character");
        assert_eq!(
            body["subject_reference"][0]["image_file"],
            reference.data_url()
        );
        assert_eq!(body["aspect_ratio"], "3:4");
        assert_eq!(body["response_format"], "base64");
        assert_eq!(body["n"], 1);
        let body = image_request_body(&request()).unwrap();
        assert!(body.get("subject_reference").is_none());
        assert_eq!(body["aspect_ratio"], "16:9");
    }

    #[test]
    fn validates_provider_limits_without_truncating_the_prompt() {
        let prompt = "猫".repeat(1500);
        assert!(image_request_body(&ImageRequest {
            prompt: &prompt,
            ..request()
        })
        .is_ok());
        let too_long = format!("{prompt}猫");
        assert!(image_request_body(&ImageRequest {
            prompt: &too_long,
            ..request()
        })
        .is_err());
        assert!(image_request_body(&ImageRequest {
            aspect_ratio: Some("5:4"),
            ..request()
        })
        .is_err());
        let body = image_request_body(&ImageRequest {
            aspect_ratio: None,
            ..request()
        })
        .unwrap();
        assert_eq!(body["aspect_ratio"], "1:1");
        let reference = ImageReference {
            mime: "image/webp".into(),
            base64: "QUJD".into(),
        };
        assert!(image_request_body(&ImageRequest {
            reference: Some(&reference),
            ..request()
        })
        .is_err());
    }

    #[test]
    fn parses_real_image_formats_instead_of_assuming_png() {
        for (format, extension) in [
            (image::ImageFormat::Png, "png"),
            (image::ImageFormat::Jpeg, "jpg"),
            (image::ImageFormat::WebP, "webp"),
        ] {
            let encoded = encoded_image(format);
            let generated = parse_image_response(&response(&encoded)).unwrap();
            assert_eq!(generated.extension, extension);
            assert_eq!(generated.base64_data, encoded);
        }
        let encoded = encoded_image(image::ImageFormat::Png);
        let generated =
            parse_image_response(&response(&format!("data:image/png;base64,{encoded}"))).unwrap();
        assert_eq!(generated.base64_data, encoded);
    }

    #[test]
    fn rejects_truncated_images_and_excessive_decoded_dimensions() {
        for signature in [
            b"\x89PNG\r\n\x1a\n".as_slice(),
            b"\xff\xd8\xff".as_slice(),
            b"RIFF\x00\x00\x00\x00WEBP".as_slice(),
        ] {
            let encoded = base64::engine::general_purpose::STANDARD.encode(signature);
            assert!(parse_image_response(&response(&encoded)).is_err());
        }
        let image = image::DynamicImage::new_rgb8(4097, 1);
        let mut output = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(output.into_inner());
        assert!(parse_image_response(&response(&encoded))
            .unwrap_err()
            .contains("解码大小上限"));
    }

    #[test]
    fn rejects_business_errors_moderation_and_malformed_images() {
        for code in [1002, 1004, 1008, 1026, 2013, 2049, 9999] {
            let text = serde_json::json!({
                "base_resp": { "status_code": code, "status_msg": "private-diagnostic" },
            })
            .to_string();
            let error = parse_image_response(&text).unwrap_err();
            assert!(error.contains(&code.to_string()));
            assert!(!error.contains("private-diagnostic"));
        }
        for text in [
            "not json".to_string(),
            "{}".to_string(),
            r#"{"base_resp":{"status_code":0},"metadata":{"failed_count":1}}"#.to_string(),
            r#"{"base_resp":{"status_code":0},"data":{"image_base64":[]}}"#.to_string(),
            response(""),
            response("not-base64"),
            response("QUJD"),
        ] {
            assert!(parse_image_response(&text).is_err(), "{text}");
        }
    }

    #[test]
    fn endpoints_follow_the_selected_region_and_accept_a_full_endpoint() {
        for base in [
            "",
            "https://api.minimax.cn/v1",
            "https://api.minimax.io/v1/",
        ] {
            let cfg = AiProviderConfig {
                provider: "minimax".into(),
                model: "image-01".into(),
                models: vec![],
                api_key: "sk-cp-test".into(),
                base_url: base.into(),
            };
            let expected_base = if base.is_empty() {
                "https://api.minimax.io/v1"
            } else {
                base.trim_end_matches('/')
            };
            assert_eq!(
                media_endpoint(&cfg, Modality::Image, "image_generation"),
                format!("{expected_base}/image_generation")
            );
            let full = AiProviderConfig {
                base_url: format!("{expected_base}/image_generation"),
                ..cfg
            };
            assert_eq!(
                media_endpoint(&full, Modality::Image, "image_generation"),
                full.base_url
            );
        }
    }

    #[tokio::test]
    async fn transport_sends_subscription_key_and_native_protocol_to_configured_endpoint() {
        use axum::{http::HeaderMap, routing::post, Json, Router};
        let (sent, received) = tokio::sync::oneshot::channel();
        let state = std::sync::Arc::new(tokio::sync::Mutex::new(Some(sent)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/v1/image_generation",
            post(
                move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                    let state = state.clone();
                    async move {
                        state
                            .lock()
                            .await
                            .take()
                            .unwrap()
                            .send((headers, body))
                            .unwrap();
                        Json(
                            serde_json::from_str::<serde_json::Value>(&response(&encoded_image(
                                image::ImageFormat::Jpeg,
                            )))
                            .unwrap(),
                        )
                    }
                },
            ),
        );
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let cfg = AiProviderConfig {
            provider: "minimax".into(),
            model: "image-01".into(),
            models: vec![],
            api_key: "sk-cp-offline-test".into(),
            base_url: format!("http://{address}/v1"),
        };
        assert_eq!(
            adaptor_for(&cfg.provider, Modality::Image),
            Some(MediaAdaptor::MiniMax)
        );
        let endpoint = media_endpoint(&cfg, Modality::Image, "image_generation");
        let text = post_json_text(
            &cfg,
            &endpoint,
            image_request_body(&request()).unwrap(),
            "MiniMax 图片生成",
        )
        .await;
        let _ = stop.send(());
        server.await.unwrap();
        let generated = parse_image_response(&text.unwrap()).unwrap();
        let (headers, body) = received.await.unwrap();
        assert_eq!(headers["authorization"], "Bearer sk-cp-offline-test");
        assert_eq!(body["model"], "image-01");
        assert_eq!(body["prompt"], request().prompt);
        assert_eq!(body["response_format"], "base64");
        assert_eq!(body["aspect_ratio"], "16:9");
        assert_eq!(generated.extension, "jpg");
    }
    #[test]
    fn webp_character_references_are_converted_to_png() {
        let reference = ImageReference {
            mime: "image/webp".into(),
            base64: encoded_image(image::ImageFormat::WebP),
        };
        let body = image_request_body(&ImageRequest {
            reference: Some(&reference),
            ..request()
        })
        .unwrap();
        assert!(body["subject_reference"][0]["image_file"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }
}
