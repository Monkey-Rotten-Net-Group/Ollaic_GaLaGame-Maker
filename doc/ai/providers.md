# 供应商与模型配置

`AiSettingsDialog` 提供 **Chat / Image / TTS / Music 四个标签页**，每类可独立选择供应商、模型、API Key，并可为自建/兼容端点设置 Base URL。Chat 标签页带「测试连接」实时校验。

## 供应商清单来自后端

供应商清单、默认模型、模型池、内置端点、是否需要 API Key，全部由后端 `src-tauri/src/ai/registry.rs` 的 `PROVIDERS` 表定义，前端通过 `list_ai_providers` 命令拉取后渲染。**前端不再内置任何供应商清单**，因此 UI 里能选到的供应商一定是后端已适配的。

新增一个供应商只需要在 `PROVIDERS` 里加一条，并为它实现对应模态的请求路径；无需改前端。

### Chat

OpenAI、Anthropic、Gemini、DeepSeek、Groq、xAI、Cohere、Ollama（本地）、custom（OpenAI 兼容）。

具备 `chat_tools` 能力的供应商启用多步工具调用，其余走 legacy 单轮补丁。`deepseek-reasoner` 这类推理模型在供应商级别支持工具调用，但模型级别不支持，由 `provider_capability` 单独降级。

### Image

OpenAI Images、Google Gemini / Imagen、阿里云 DashScope / 通义万相、火山引擎 / 即梦 / 豆包、智谱 CogView、SiliconFlow、Midjourney Proxy（OpenAI 兼容）、Stable Diffusion WebUI（本地）、custom。

### TTS

OpenAI TTS、ElevenLabs、阿里云 DashScope / CosyVoice、火山引擎 / 豆包语音、custom。

> CosyVoice 走 WebSocket 协议，Qwen-TTS 走 HTTP；Sambert 系列协议更老，未适配。

### Music

custom（OpenAI 兼容音乐端点）、OpenAI 兼容、SiliconFlow。

## Base URL 与 API Key

- **Base URL 留空**时使用该供应商在 registry 中的内置端点。只有内置端点为空的供应商（custom、Midjourney Proxy）才必须填写，UI 会在提示里注明「必填」。
- 输入框里的灰色示例文本只是 placeholder，**不会被写入配置**，因此不会出现「保存了示例地址导致请求失败」。
- `requires_api_key = false` 的供应商（Ollama、Stable Diffusion WebUI、custom）可以留空 Key，UI 会提示「该供应商通常不需要 Key」。

## 配置存储与保存时机

供应商配置是**全局的，不按项目隔离**：存放在用户配置目录 `<config>/ollaic/` 下的 `ai.json`、`ai-image.json`、`ai-tts.json`、`ai-music.json`，所有项目共用同一份。

对话框每次打开都从磁盘重新读取，因此未保存的草稿会被丢弃。为避免"填好、测通、忘了保存"导致配置丢失：

- **聊天标签页的「测试连接」成功后会自动保存该配置**，并在成功提示里注明「已自动保存」。
- 任何后续编辑（改 Key/模型/供应商）会清除验证结果与自动保存标记，需要重新验证或点底部「保存」。
- 图片 / 音频 / 音乐标签页仍以底部「保存」为准。
- 保存的供应商如果在后续版本中被移除，打开对话框时会自动回退到该标签页的第一个可选供应商。

## 调用日志

`listAiLogs` / `clearAiLogs` 记录供应商、模型、动作（chat/image/tts/music）、端点、成功/失败与消息；可查看最近 80 条并清空。写入前会对 Key、Token、Authorization 做脱敏。

## 相关源码

- `src-tauri/src/ai/registry.rs`（供应商元数据单一真源）
- `src-tauri/src/ai/provider_capability.rs`（能力解析与模态校验，读 registry）
- `src-tauri/src/ai/commands.rs`（Tauri 命令、chat、日志）
- `design/src/app/components/AiSettingsDialog.tsx`（设置 UI，清单来自后端）
- `design/src/app/lib/ai-ipc.ts`（配置读写、供应商清单、连接校验、日志）
