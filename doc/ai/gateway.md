# 媒体网关（多供应商协议统一）

图片 / 语音 / 音乐生成统一走 `src-tauri/src/ai/gateway/` 这一进程内网关。它的职责只有一件事：把**统一的请求 DTO** 翻译成各供应商的私有协议，再把各家五花八门的响应收敛回统一的 `GeneratedMedia`。

设计参考了 [new-api](https://github.com/QuantumNous/new-api) 的 relay/relaykit 分层，但按本项目「本地优先、单用户」的约束做了裁剪：不引入独立进程、不做多渠道路由、不做计费。

## 分层

```
Tauri 命令 / Pipeline / 素材队列
        ↓  统一请求 DTO（types.rs）
    gateway::generate_image / generate_tts / generate_music
        ↓  校验 + 供应商解析
    adaptors::MediaAdaptor           ← 只做协议转换
        ↓  transport.rs              ← 一个客户端、一个超时、一个 URL 解析器
    供应商
```

| 模块 | 职责 |
|------|------|
| `types.rs` | `ImageRequest` / `TtsRequest` / `MusicRequest` / `GeneratedMedia` / `ImageReference`，以及格式与 MIME 归一化 |
| `transport.rs` | 唯一的 HTTP 客户端与超时、唯一的 Base URL 解析（读 registry）、JSON/音频字节的统一发送与错误日志 |
| `adaptors/` | 每种协议一个文件，`MediaAdaptor` enum 负责分发 |
| `mod.rs` | 三个入口函数 + 共享的前置校验 |

## 边界：网关不做什么

Adaptor 只做协议转换。以下能力留在宿主（`ai::commands`）并被调用：

- **调用日志与密钥脱敏**（`log_provider_event`）
- **供应商返回 URL 的安全下载**（`download_generated_media`，带 SSRF 防护：私有地址拒绝、DNS 钉住、重定向逐跳校验、大小上限、Content-Type 白名单）

这对应 new-api 让 `relaykit` 不含传输、鉴权与持久化的模块边界。

## 扩展点

新增一个供应商协议 = 在 `adaptors/` 加一个文件 + 在 `MediaAdaptor` 加一个变体 + 在 `adaptor_for` 加一条映射。

**不需要**改前端，也不需要改任何 `match cfg.provider` —— 改造前这样的 match 散落在 5 处。

### 与 registry 的分工

- `ai::registry` 决定**哪些 (供应商, 模态) 组合对用户开放**（同时喂给设置 UI）。
- `adaptors::adaptor_for` 决定**哪段代码实现这个组合**。

两者必须完全一致，由 `adaptors/mod.rs` 的两个双向测试强制：registry 提供的每个组合都必须有 adaptor，每个 adaptor 组合也都必须被 registry 提供。任何一边漏改都会在 `cargo test` 失败，而不是等到用户点「生成」时才报错。

## 分发表

| Adaptor | 图片 | 语音 | 音乐 |
|---------|------|------|------|
| `OpenAiCompatible` | openai / custom / zhipu / siliconflow / midjourney / volcengine | openai / custom | openai / custom / siliconflow |
| `DashScope` | aliyun（异步任务轮询） | aliyun（Qwen-TTS HTTP / CosyVoice WebSocket） | — |
| `Gemini` | gemini（inline base64） | — | — |
| `SdWebUi` | sd-webui（本地） | — | — |
| `ElevenLabs` | — | elevenlabs | — |
| `Volcengine` | — | volcengine（行分隔流式） | — |

火山引擎的图片走 OpenAI 兼容方言（Seedream 变体），语音走自有流式协议，因此落在两个不同的 adaptor 上。

## URL 解析

改造前有 4 套并行的端点拼接逻辑，互不知道对方存在。现在只有一条路径：

```
用户填了 Base URL ? 用它 : registry 内置默认
```

其中示例地址（`api.example.com`）视同未填，让内置默认接管。Gemini 因为把模型写在路径里，在这之上多一步 `{base}/models/{model}:{action}`。

## 相关源码

- `src-tauri/src/ai/gateway/`（网关本体）
- `src-tauri/src/ai/registry.rs`（供应商元数据单一真源）
- `src-tauri/src/ai/commands.rs`（Tauri 命令壳、chat、日志、安全下载）
- [供应商与模型配置](./providers.md)
