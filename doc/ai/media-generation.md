# AI 素材与立绘生成

除文本编辑外,AI 还能生成图像(背景/CG/立绘)与音频(语音/TTS),用于快速填充素材。

## 图像生成

- 接口:`aiGenerateImage`(`ai-ipc.ts`),输入文本提示 + 模型名,返回 base64 图像。
- **背景 / CG 生成**(`AssetManager.tsx`):输入描述、选择目标模型(支持多模型批量),为「场景 / CG」标签页生成图像;保存时带分类标签并建议可用文件名。
- **角色立绘生成**(`CharacterPanel.tsx`):`buildSpritePrompt()` 结合角色性格、表情与可选指令生成立绘;支持「主体参考图」与各表情变体,生成后自动保存并关联到角色记录。详见[角色立绘](../characters/characters-and-sprites.md)。

## 立绘自动抠背景

AI 出图大多是白底/纯色底,不带透明通道。立绘生成后会自动用**本地 ONNX 模型**抠掉背景再入库,无需联网、无额外费用。

- 接口:`removeBackground`(`ai-ipc.ts`)→ Rust 命令 `remove_background`(`matting` 模块),输入 base64 图像,输出带 alpha 通道的透明 PNG。
- 模型:`isnet-anime`(Apache-2.0,专为动漫角色训练),`isnet-anime.onnx` 随安装包内置于 `src-tauri/models/`,经 `tauri.conf.json` 的 `resources` 打包。推理用 `ort`(ONNX Runtime),会话进程内缓存(模型约 168MB,只加载一次)。
- 预处理/后处理对齐 rembg 的 isnet-anime 实现:resize 1024×1024 → 逐通道减均值 → NCHW float32;输出单通道 mask 做 min-max 归一化后作为 alpha,缩放回原尺寸。
- 仅角色立绘走抠图;背景/CG 不抠(它们本就需要完整背景)。
- **失败兜底**:抠图失败不阻断生成,回退使用原图。抠图成功时,未抠的原图保留到 `figure/<角色ID>/_raw/`(列表不递归子目录,故不污染素材库展示),便于回溯或换用其他抠图方式。

## 语音 / TTS 生成

- 接口:`aiGenerateTts`(`ai-ipc.ts`),输入文本 + 语音提示(角色 + 情绪 + 自定义)+ 模型 + 格式。
- 用于生成配音资产(归类于 vocal)。情绪选项含平静、温柔、开心、悲伤等。

## 进度反馈

长耗时的图像/音频任务通过 `listenAiMediaGenerationProgress`(`ai-ipc.ts`)推送事件(供应商、模型、阶段、尝试计数),`AssetManager` 与 `CharacterPanel` 内联展示进度卡。

## 分模态配置

聊天、图像、TTS、音乐各自独立配置,可路由到不同供应商:
- `getAiConfig`(聊天)/ `getAiImageConfig`(图像)/ `getAiTtsConfig`(TTS)/ `getAiMusicConfig`(音乐)。
- 例如:聊天用 OpenAI、图像用 Gemini、TTS 用 ElevenLabs。详见[供应商与模型配置](./providers.md)。

## 请求如何发出

图像 / 语音 / 音乐的实际请求统一经过 `src-tauri/src/ai/gateway/`:调用方只构造统一的请求 DTO,由 adaptor 翻译成各供应商协议,再把响应收敛回统一的 `GeneratedMedia`。批量 TTS 与单条 TTS 走同一条路径,因此支持的供应商集合始终一致。详见[媒体网关](./gateway.md)。

## 相关源码
- `design/src/app/lib/ai-ipc.ts`(`aiGenerateImage` / `aiGenerateTts` / `generateMusic` / `removeBackground` / 进度监听 / 各模态配置)
- `design/src/app/components/AssetManager.tsx`、`design/src/app/components/CharacterPanel.tsx`
- `src-tauri/src/ai/gateway/`(多供应商协议统一与分发)
- `src-tauri/src/matting/`(`remove_background` 命令与本地 ONNX 抠图实现)
