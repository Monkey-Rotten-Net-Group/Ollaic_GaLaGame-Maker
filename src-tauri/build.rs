use std::path::PathBuf;

/// 抠图模型（BiRefNet-lite fp16，MIT）的下载候选地址与预期大小。
/// 模型不入 git 仓库（115MB），改由构建时下载到 `models/`，再由 Tauri 打进安装包。
const DEFAULT_MODEL_URLS: &[&str] = &[
    "https://hf-mirror.com/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx",
    "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx",
];
const MODEL_EXPECTED_BYTES: u64 = 114_538_221;
const MODEL_FILENAME: &str = "birefnet-lite-fp16.onnx";
/// 下载读取上限（略高于预期大小，绕过 ureq 默认 10MB 限制）。
const DOWNLOAD_LIMIT_BYTES: u64 = 150 * 1024 * 1024;

fn main() {
    // 仅在 build.rs 自身变化时重跑下载检查；模型文件不参与（避免每次都校验大文件）。
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=MATTING_MODEL_PATH");
    println!("cargo:rerun-if-env-changed=MATTING_SKIP_MODEL_DOWNLOAD");
    println!("cargo:rerun-if-env-changed=HF_ENDPOINT");

    if let Err(e) = ensure_matting_model() {
        // 不让构建直接崩溃在网络问题上：打印醒目警告，指明手动补救方式。
        // 运行时若仍找不到模型，remove_background 会返回明确错误。
        println!("cargo:warning=抠图模型准备失败：{e}");
        println!(
            "cargo:warning=可手动下载 https://hf-mirror.com/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx 到 src-tauri/models/{MODEL_FILENAME}，或设置 MATTING_MODEL_PATH 指向已有模型。"
        );
    }

    tauri_build::build()
}

fn ensure_matting_model() -> Result<(), String> {
    // 已通过环境变量指定外部模型路径时，跳过下载（开发/CI 自带模型的场景）。
    if let Ok(p) = std::env::var("MATTING_MODEL_PATH") {
        if PathBuf::from(&p).is_file() {
            println!("cargo:warning=使用 MATTING_MODEL_PATH 指定的抠图模型，跳过下载：{p}");
            return Ok(());
        }
    }
    // 显式跳过开关（离线构建、已确认模型就位时使用）。
    if std::env::var("MATTING_SKIP_MODEL_DOWNLOAD").is_ok() {
        return Ok(());
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let models_dir = manifest_dir.join("models");
    let model_path = models_dir.join(MODEL_FILENAME);

    // 已存在且大小匹配 → 认为完好，跳过。
    if let Ok(meta) = std::fs::metadata(&model_path) {
        if meta.len() == MODEL_EXPECTED_BYTES {
            return Ok(());
        }
        // 大小不符：可能是半截/损坏文件，删除后重新下载。
        println!(
            "cargo:warning=已存在的抠图模型大小异常（{} 字节，预期 {}），将重新下载。",
            meta.len(),
            MODEL_EXPECTED_BYTES
        );
        let _ = std::fs::remove_file(&model_path);
    }

    std::fs::create_dir_all(&models_dir).map_err(|e| format!("创建 models 目录失败: {e}"))?;

    println!(
        "cargo:warning=正在下载抠图模型 {MODEL_FILENAME}（约 115MB，首次构建需要一些时间）..."
    );

    let mut candidate_urls: Vec<String> = Vec::new();
    if let Ok(endpoint) = std::env::var("HF_ENDPOINT") {
        let endpoint = endpoint.trim_end_matches('/');
        candidate_urls.push(format!(
            "{endpoint}/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx"
        ));
    }
    for url in DEFAULT_MODEL_URLS {
        if !candidate_urls.iter().any(|u| u == *url) {
            candidate_urls.push(url.to_string());
        }
    }

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(600)))
        .build()
        .into();

    let mut last_error = String::new();
    let mut downloaded_bytes: Option<Vec<u8>> = None;

    for url in &candidate_urls {
        match agent.get(url).call() {
            Ok(mut response) => {
                match response
                    .body_mut()
                    .with_config()
                    .limit(DOWNLOAD_LIMIT_BYTES)
                    .read_to_vec()
                {
                    Ok(bytes) => {
                        let downloaded = bytes.len() as u64;
                        if downloaded == MODEL_EXPECTED_BYTES {
                            downloaded_bytes = Some(bytes);
                            break;
                        } else {
                            last_error = format!(
                                "从 {url} 下载的模型大小不符：得到 {downloaded} 字节，预期 {MODEL_EXPECTED_BYTES}"
                            );
                        }
                    }
                    Err(e) => {
                        last_error = format!("读取 {url} 下载内容失败: {e}");
                    }
                }
            }
            Err(e) => {
                last_error = format!("请求 {url} 失败: {e}");
            }
        }
    }

    let bytes = downloaded_bytes.ok_or_else(|| {
        format!("所有镜像源下载均失败。最后错误: {last_error}")
    })?;

    // 先写临时文件再原子重命名，避免构建中断留下半截文件。
    let tmp_path = models_dir.join(format!("{MODEL_FILENAME}.part"));
    std::fs::write(&tmp_path, &bytes).map_err(|e| format!("写入临时模型文件失败: {e}"))?;
    std::fs::rename(&tmp_path, &model_path).map_err(|e| format!("重命名模型文件失败: {e}"))?;

    println!("cargo:warning=抠图模型下载完成：{}", model_path.display());
    Ok(())
}
