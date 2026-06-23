//! 背景抠除（matting）：使用本地 ONNX 模型 BiRefNet-lite（MIT，通用分割）
//! 为 AI 生成的立绘去除背景，输出带 alpha 通道的透明 PNG。
//!
//! 预处理 / 后处理规格对齐 HuggingFace BiRefNet_lite-ONNX：
//! - 输入：转 RGB → resize 1024×1024（Bilinear）→ /255 → 逐通道
//!   (c - mean)/std，mean=(0.485,0.456,0.406)、std=(0.229,0.224,0.225) → NCHW float32。
//! - 输出：raw logits → sigmoid → 8-bit alpha mask → guided filter 细化 → 缩放回原尺寸。

use crate::ai::commands::GeneratedMedia;
use base64::Engine;
use image::imageops::FilterType;
use image::{GrayImage, RgbaImage};
use ndarray::Array4;
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const MODEL_SIZE: usize = 1024;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];
const MODEL_FILENAME: &str = "birefnet-lite-fp16.onnx";

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn resolve_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("MATTING_MODEL_PATH") {
        let candidate = PathBuf::from(p);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join(format!("models/{MODEL_FILENAME}"));
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("models/{MODEL_FILENAME}"));
    if dev_path.is_file() {
        return Ok(dev_path);
    }
    Err(format!("未找到抠图模型 {MODEL_FILENAME}，请确认随安装包内置或设置 MATTING_MODEL_PATH。"))
}

#[tauri::command]
pub async fn remove_background(
    app: AppHandle,
    base64_data: String,
) -> Result<GeneratedMedia, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let model_path = resolve_model_path(&app)?;
        let encoded = base64_data
            .split_once(',')
            .map(|(_, payload)| payload)
            .unwrap_or(&base64_data);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|e| format!("解析待抠图图像失败: {e}"))?;

        let png_bytes = matte_image(&model_path, &bytes)?;
        Ok(GeneratedMedia {
            base64_data: base64::engine::general_purpose::STANDARD.encode(&png_bytes),
            extension: "png".to_string(),
        })
    })
    .await
    .map_err(|e| format!("抠图任务调度失败: {e}"))?
}

fn matte_image(model_path: &Path, image_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let dynamic =
        image::load_from_memory(image_bytes).map_err(|e| format!("解码待抠图图像失败: {e}"))?;
    let rgba = dynamic.to_rgba8();
    let (orig_w, orig_h) = (rgba.width(), rgba.height());

    let input = preprocess(&dynamic);
    let mask = run_inference(model_path, input)?;

    // 在模型分辨率 (1024x1024) 上用 guided filter 细化 mask：
    // 以缩放后的原图灰度为引导，让 mask 边界对齐真实颜色边缘（头发丝等）。
    let mask_img = GrayImage::from_raw(MODEL_SIZE as u32, MODEL_SIZE as u32, mask)
        .ok_or_else(|| "构建 mask 图像失败".to_string())?;
    let guide = dynamic
        .resize_exact(MODEL_SIZE as u32, MODEL_SIZE as u32, FilterType::Triangle)
        .to_luma8();
    let refined = guided_filter(&guide, &mask_img, 8, 0.01);
    let mask_resized = image::imageops::resize(&refined, orig_w, orig_h, FilterType::Lanczos3);

    // 从四角采样检测背景色：AI 生图背景为纯色，角落必定是背景。
    let bg = detect_background_color(&rgba);
    let bg_f = [bg[0] as f32, bg[1] as f32, bg[2] as f32];

    let mut out = RgbaImage::new(orig_w, orig_h);
    for (x, y, pixel) in out.enumerate_pixels_mut() {
        let src = rgba.get_pixel(x, y);
        let alpha = mask_resized.get_pixel(x, y)[0];

        // 前景色去污染：半透明边缘的 RGB 受检测到的背景色混入，反向分离出真实前景色。
        let (r, g, b) = if alpha > 5 && alpha < 250 {
            let a = alpha as f32 / 255.0;
            let clamp = |v: f32| v.clamp(0.0, 255.0) as u8;
            (
                clamp((src[0] as f32 - (1.0 - a) * bg_f[0]) / a),
                clamp((src[1] as f32 - (1.0 - a) * bg_f[1]) / a),
                clamp((src[2] as f32 - (1.0 - a) * bg_f[2]) / a),
            )
        } else {
            (src[0], src[1], src[2])
        };
        *pixel = image::Rgba([r, g, b, alpha]);
    }

    let mut png_bytes: Vec<u8> = Vec::new();
    out.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("编码透明 PNG 失败: {e}"))?;
    Ok(png_bytes)
}

/// 从图像四角采样像素，取各通道中位数作为背景色。
/// AI 生成的立绘背景为纯色，四角一定是背景区域。
fn detect_background_color(img: &RgbaImage) -> [u8; 3] {
    let (w, h) = img.dimensions();
    let margin = (w.min(h) / 20).max(1);
    let mut rs = Vec::new();
    let mut gs = Vec::new();
    let mut bs = Vec::new();
    // 四角各采样 margin×margin 区域
    for &(x0, y0) in &[(0, 0), (w - margin, 0), (0, h - margin), (w - margin, h - margin)] {
        for dy in 0..margin {
            for dx in 0..margin {
                let p = img.get_pixel(x0 + dx, y0 + dy);
                rs.push(p[0]);
                gs.push(p[1]);
                bs.push(p[2]);
            }
        }
    }
    rs.sort_unstable();
    gs.sort_unstable();
    bs.sort_unstable();
    let mid = rs.len() / 2;
    [rs[mid], gs[mid], bs[mid]]
}

/// Guided filter (He et al. 2010)：用引导图 I 的边缘信息细化输入 p（mask），
/// 让 mask 边界对齐图像的真实颜色边缘。O(N) 复杂度，通过 box filter 实现。
fn guided_filter(guide: &GrayImage, input: &GrayImage, radius: u32, eps: f64) -> GrayImage {
    let (w, h) = guide.dimensions();
    let n = (w * h) as usize;

    let mut gi = vec![0.0f64; n];
    let mut pi = vec![0.0f64; n];
    for i in 0..n {
        gi[i] = guide.as_raw()[i] as f64 / 255.0;
        pi[i] = input.as_raw()[i] as f64 / 255.0;
    }

    let mean_i = box_filter(&gi, w, h, radius);
    let mean_p = box_filter(&pi, w, h, radius);

    let ip: Vec<f64> = gi.iter().zip(pi.iter()).map(|(&a, &b)| a * b).collect();
    let mean_ip = box_filter(&ip, w, h, radius);

    let ii: Vec<f64> = gi.iter().map(|&v| v * v).collect();
    let mean_ii = box_filter(&ii, w, h, radius);

    // a = cov(I,p) / (var(I) + eps),  b = mean_p - a * mean_i
    let mut a = vec![0.0f64; n];
    let mut b = vec![0.0f64; n];
    for i in 0..n {
        let cov = mean_ip[i] - mean_i[i] * mean_p[i];
        let var = mean_ii[i] - mean_i[i] * mean_i[i];
        a[i] = cov / (var + eps);
        b[i] = mean_p[i] - a[i] * mean_i[i];
    }

    let mean_a = box_filter(&a, w, h, radius);
    let mean_b = box_filter(&b, w, h, radius);

    let mut out = GrayImage::new(w, h);
    for i in 0..n {
        let v = (mean_a[i] * gi[i] + mean_b[i]) * 255.0;
        out.as_mut().as_mut()[i] = v.round().clamp(0.0, 255.0) as u8;
    }
    out
}

/// O(N) box filter via cumulative sums (integral image approach).
fn box_filter(data: &[f64], w: u32, h: u32, radius: u32) -> Vec<f64> {
    let (w, h, r) = (w as usize, h as usize, radius as i64);
    let n = w * h;
    let mut tmp = vec![0.0f64; n];
    let mut out = vec![0.0f64; n];

    // 水平累积求和
    for y in 0..h {
        let row = y * w;
        let mut cum = vec![0.0f64; w + 1];
        for x in 0..w {
            cum[x + 1] = cum[x] + data[row + x];
        }
        for x in 0..w {
            let left = (x as i64 - r).max(0) as usize;
            let right = ((x as i64 + r) as usize).min(w - 1) + 1;
            tmp[row + x] = cum[right] - cum[left];
        }
    }

    // 垂直累积求和 + 归一化
    for x in 0..w {
        let mut cum = vec![0.0f64; h + 1];
        for y in 0..h {
            cum[y + 1] = cum[y] + tmp[y * w + x];
        }
        for y in 0..h {
            let top = (y as i64 - r).max(0) as usize;
            let bot = ((y as i64 + r) as usize).min(h - 1) + 1;
            let x_left = (x as i64 - r).max(0) as usize;
            let x_right = ((x as i64 + r) as usize).min(w - 1);
            let area = ((x_right - x_left + 1) * (bot - top)) as f64;
            out[y * w + x] = (cum[bot] - cum[top]) / area;
        }
    }
    out
}

/// BiRefNet-lite 预处理：RGB → resize 1024×1024 → /255 → ImageNet 归一化 → NCHW float32。
fn preprocess(dynamic: &image::DynamicImage) -> Array4<f32> {
    let resized = dynamic
        .resize_exact(MODEL_SIZE as u32, MODEL_SIZE as u32, FilterType::Triangle)
        .to_rgb8();

    let mut input = Array4::<f32>::zeros((1, 3, MODEL_SIZE, MODEL_SIZE));
    for (x, y, pixel) in resized.enumerate_pixels() {
        let (xi, yi) = (x as usize, y as usize);
        for c in 0..3 {
            let v = pixel[c] as f32 / 255.0;
            input[[0, c, yi, xi]] = (v - MEAN[c]) / STD[c];
        }
    }
    input
}

/// BiRefNet 输出 raw logits → sigmoid → 8-bit alpha mask。
fn run_inference(model_path: &Path, input: Array4<f32>) -> Result<Vec<u8>, String> {
    let mut guard = SESSION.lock().map_err(|_| "抠图会话锁中毒".to_string())?;
    if guard.is_none() {
        let session = Session::builder()
            .map_err(|e| format!("创建抠图会话失败: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("加载抠图模型失败 {}: {e}", model_path.display()))?;
        *guard = Some(session);
    }
    let session = guard.as_mut().expect("session 已初始化");

    let tensor = Tensor::from_array(input).map_err(|e| format!("构建输入张量失败: {e}"))?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| format!("抠图推理失败: {e}"))?;

    if outputs.len() == 0 {
        return Err("抠图推理未返回任何输出".to_string());
    }
    let (_shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("读取抠图输出失败: {e}"))?;

    if data.len() < MODEL_SIZE * MODEL_SIZE {
        return Err(format!(
            "抠图输出尺寸异常：期望至少 {} 个像素，实际 {}",
            MODEL_SIZE * MODEL_SIZE,
            data.len()
        ));
    }

    // BiRefNet 输出 raw logits，需要 sigmoid 激活转换为 0..1 概率。
    // 取最后 H*W 个元素（BiRefNet 输出 shape 可能是 [1,1,H,W]）。
    let offset = data.len() - MODEL_SIZE * MODEL_SIZE;
    let mask: Vec<u8> = data[offset..]
        .iter()
        .map(|&v| {
            let prob = 1.0 / (1.0 + (-v).exp()); // sigmoid
            (prob * 255.0).round().clamp(0.0, 255.0) as u8
        })
        .collect();
    Ok(mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matte_image_produces_transparent_png() {
        let model_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("models/{MODEL_FILENAME}"));
        if !model_path.is_file() {
            eprintln!("跳过：未找到模型 {}", model_path.display());
            return;
        }

        let mut img = RgbaImage::from_pixel(256, 256, image::Rgba([255, 255, 255, 255]));
        for y in 80..176 {
            for x in 80..176 {
                img.put_pixel(x, y, image::Rgba([220, 30, 30, 255]));
            }
        }
        let mut src_png: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut src_png), image::ImageFormat::Png)
            .unwrap();

        let out_png = matte_image(&model_path, &src_png).expect("抠图应成功");
        let out = image::load_from_memory(&out_png).expect("输出应为合法图像");
        let out = out.to_rgba8();
        assert_eq!(out.dimensions(), (256, 256), "尺寸应保持不变");

        let center_alpha = out.get_pixel(128, 128)[3] as u32;
        let corner_alpha = out.get_pixel(2, 2)[3] as u32;
        assert!(
            center_alpha > corner_alpha,
            "前景应比背景更不透明：center={center_alpha} corner={corner_alpha}"
        );
    }

    #[test]
    fn matte_real_sprites() {
        let model_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("models/{MODEL_FILENAME}"));
        if !model_path.is_file() {
            eprintln!("跳过：未找到模型");
            return;
        }
        let raw_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap()
            .join("不敗終焉與世界之花/game/figure/char_18acd2da47372ddf/_raw");
        if !raw_dir.is_dir() {
            eprintln!("跳过：未找到测试图片目录 {}", raw_dir.display());
            return;
        }
        let out_dir = std::env::temp_dir().join("matting_test_output");
        let _ = std::fs::create_dir_all(&out_dir);

        for entry in std::fs::read_dir(&raw_dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().map_or(true, |e| e != "png") { continue; }
            let name = path.file_stem().unwrap().to_str().unwrap().to_string();
            eprintln!("处理: {name}");

            let bytes = std::fs::read(&path).unwrap();
            let start = std::time::Instant::now();
            let result = matte_image(&model_path, &bytes).expect("抠图应成功");
            eprintln!("  耗时: {:?}", start.elapsed());

            let out_path = out_dir.join(format!("{name}_matted.png"));
            std::fs::write(&out_path, &result).unwrap();
            eprintln!("  输出: {}", out_path.display());

            let out_img = image::load_from_memory(&result).unwrap().to_rgba8();
            let (w, h) = out_img.dimensions();
            let transparent_count = out_img.pixels().filter(|p| p[3] == 0).count();
            let total = (w * h) as usize;
            eprintln!("  尺寸: {w}x{h}, 透明像素: {transparent_count}/{total} ({:.1}%)",
                transparent_count as f64 / total as f64 * 100.0);
        }
    }

    #[test]
    fn guided_filter_preserves_shape() {
        let g = GrayImage::from_raw(4, 4, vec![
            0, 0, 255, 255,
            0, 0, 255, 255,
            255, 255, 0, 0,
            255, 255, 0, 0,
        ]).unwrap();
        let p = g.clone();
        let out = guided_filter(&g, &p, 1, 0.01);
        assert_eq!(out.dimensions(), (4, 4));
    }
}
