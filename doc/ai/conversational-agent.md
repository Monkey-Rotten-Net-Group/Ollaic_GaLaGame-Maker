# 对话编辑 Agent

AI 助手以多轮对话方式理解创作意图,通过函数调用读取项目数据、暂存脚本/角色/记忆的修改。

## 执行模式

### 多步 function-calling 循环
对原生函数调用可靠的供应商(见 `FC_PROVIDERS`:OpenAI、Anthropic、Gemini、DeepSeek、Groq、xAI、Cohere 等),Agent 最多执行 **6 轮**:模型调用读/写工具 → 工具结果回灌 → 继续推理,直至给出结论或产出暂存变更。
- 实现:`runAgentLoop`(`useAiAgent.ts`)。

### legacy 单轮兜底
不支持函数调用的供应商(如 Ollama、部分自建端点),一次性收到完整上下文,必须在单条响应里返回 JSON 补丁(patch)或纯聊天回复。
- 实现:`runLegacyTurn`(`useAiAgent.ts`)。

## 可用工具

定义于 `lib/ai-tools.ts`。读工具只读、支持分页与上下文截断;写工具**只校验并返回暂存负载(StagedWrite),不直接落盘**。

| 类别 | 工具 | 作用 |
|------|------|------|
| 读 | `list_scenes` | 列出项目所有场景（附带提取的章节名与大纲，帮助模型理解全局） |
| 读 | `read_scene` | 读取某场景的节点(带行号) |
| 读 | `search_assets` | 检索素材库 |
| 读 | `list_characters` / `get_character` | 列出 / 读取角色 |
| 读 | `read_memory` | 读取项目记忆 |
| 写 | `set_scene_header` | 暂存场景章节名 / 大纲更新 |
| 写 | `insert_dialogue_block` | 暂存结构化剧情块,由系统生成 WebGAL txt |
| 写 | `create_branch` | 暂存选项分支,并创建目标场景 |
| 写 | `edit_scene` | 暂存对场景的修改 |
| 写 | `insert_figure` | 按角色 + 表情暂存立绘插入,由系统解析真实素材文件 |
| 写 | `create_scene` | 暂存新建场景 |
| 写 | `create_character` | 暂存新建角色设定卡 |
| 写 | `plan_character_sprites` | 暂存已有角色的表情槽与生图提示词规划 |
| 写 | `edit_character` | 暂存角色修改 |
| 写 | `edit_memory` | 暂存项目记忆修改 |

### 结构化故事搭建

完整故事搭建优先使用高层工具,降低模型直接手写 txt/行号 patch 的失败面:

- `set_scene_header`: 设置 `; 章节:` 与 `; 大纲:` 注释,用于组织章节结构。
- `insert_dialogue_block`: 插入结构化剧情行,支持旁白、对白、黑屏文字、背景、立绘、BGM/音效、跳转、标签、结束等常见内容。素材命令仍会校验素材库,不能引用不存在的文件。
- `create_branch`: 在源场景插入 `choose`,同时暂存创建每个目标场景;目标场景可带章节、大纲和初始剧情行。
- `edit_scene`: 保留为底层补丁工具,仅在高层工具无法表达特殊 WebGAL 命令时使用。

### 角色创建工具

`create_character` 用于用户要求新增角色、人物卡或主要配角设定时。它只接受角色基础字段,包括 `name`、`aliases`、`description`、`personality`、`stance`、`keywords`、`dialogueStyle`、`gender`、`age`、`voiceTimbre`、`colorTheme`、`notes`,以及可选 `sprites` 表情槽。

- `sprites` 只保存 `emotion` 和可选 `prompt`;`file` 不由 Agent 直接填写,避免编造立绘文件。
- `plan_character_sprites` 可给已有角色追加/更新表情槽和生图提示词,同样不生成图片、不绑定文件。
- staging 会补一个默认表情槽,过滤未知字段,拒绝与现有角色同名的创建请求。
- 落盘仍走用户确认后的 change-set;确认后调用后端 `create_character`,由后端生成真实角色 id。失败回滚时会删除已经创建成功的角色。
- 不提供角色删除工具。删除角色会影响脚本引用、立绘目录和关系图,当前 Agent 工具体系先保留为手动流程。

## 系统提示与上下文

精简的系统提示描述工具语义 + 当前场景(带行号)+ WebGAL txt 语法;角色上下文、素材清单、项目记忆按需单独注入。上下文做了截断以适配窗口:当前场景脚本裁到约 120 行(前 40 + 后 80),素材每类最多 24 条,聊天历史保留最近 8 轮,超 500 字的助手历史会被摘要。
- 实现:`buildAgentSystemContext`、`truncateContextMessages`(`story-agent.ts`)。

## 状态机

`useAiAgent` 维护以下状态:
- `idle` 等待输入 → `generating` 首轮生成 → `tooling` 调用工具
- `pending` 变更待确认 → `accepted` / `reverted` / `conflict` 已处理
- `error` 出错(可重试/可跳设置)

面板状态徽标:生成中 / 等待确认 / 需要处理 / 等待输入。

## 消息模型与健壮性

- **非流式「块」消息模型**: 为了规避跨平台 IPC 与多步流式响应中极易产生的死锁与竞态，多步 Agent 循环在底层使用非流式命令 `ai_chat_turn` 进行完整的一轮往返。
- **渲染**: AI 回复被组织为 `steps: AssistantStep[]` 的数组形式。在 `AiMessageBubble` 中，文本内容和该轮产生的工具调用会被合并渲染为一个“块”，确保即便是纯文本分析和工具调用同处一轮，文本也不会被丢弃，全貌完整渲染。
- **调试 trace**: 每次 Agent/legacy 回合结束后,前端会写一条 JSONL 到 Tauri 配置目录的 `ai-agent-trace.jsonl`,用于复盘真实模型输出、工具调用参数、工具返回值和 staging 错误。
- **重试与冷却**:限流错误触发 30 秒冷却;超时最多重试 2 次。
- **停止**:生成过程中可中断。

## Agent Trace

普通 AI 调用日志 `ai-log.jsonl` 只记录供应商、模型、端点和调用成功/失败摘要;它不能排查“模型到底调用了什么工具”或“编辑器为什么拒绝写入”。因此 Agent 另有调试 trace:

| 项 | 说明 |
|----|------|
| 文件 | `ai-agent-trace.jsonl` |
| 路径 | Tauri 配置目录,macOS 通常是 `~/Library/Application Support/ciallo/ai-agent-trace.jsonl` |
| 写入命令 | `append_ai_agent_trace` |
| 路径查询命令 | `get_ai_agent_trace_path` |
| 前端入口 | `appendAiAgentTrace`(`ai-ipc.ts`) + `writeAgentTrace`(`useAiAgent.ts`) |

每行是一个完整 JSON 对象,对应一次用户 prompt 的执行过程。主要字段:

| 字段 | 说明 |
|------|------|
| `traceId` / `createdAt` | 本次 trace 标识与创建时间 |
| `projectId` / `currentSceneName` / `assistantId` | 当前项目、场景和助手消息 |
| `prompt` | 用户本轮输入 |
| `mode` | `function_calling` 或 `legacy` |
| `assetCount` | staging 前刷新到的素材数量,用于判断素材缓存是否过期 |
| `turns[]` | 每个模型回合 |
| `turns[].modelText` | 模型该回合返回的文本 |
| `turns[].toolCalls[]` | 模型调用的工具、参数、工具类型、UI label、成功/失败、工具结果或错误 |
| `edits` | 最终暂存出来的变更摘要 |
| `finalText` / `outcome` / `error` | 最终回复、结果类型和异常信息 |

trace 设计原则:
- 写 trace 是 best-effort,失败只打印 console 警告,不影响用户流程。
- 后端对常见密钥字段和值做脱敏,包括 `apiKey`、`api_key`、`token`、`authorization`、`Bearer ...` 等。
- trace 字符串字段上限比普通日志大,用于保留较完整的模型输出和工具返回。
- `runAgentLoop` 在 staging 前重新 `listAllAssets(projectPath)`,并用 fresh asset list 构建 staging context;trace 的 `assetCount` 用来辅助确认写工具是否拿到了最新素材库。

## 真实模型 Harness

后端有一个 ignored Rust test 可直接用 cargo 的测试 CLI 调真实聊天模型,用于检查模型是否会按提示选择工具。当前 harness 聚焦 `insert_figure` 场景:它提供内置的场景、角色和立绘素材 stub,要求真实模型调用 `insert_figure`,最后断言预览里包含正确的 `changeFigure` 行。

运行方式:

```bash
cargo test --manifest-path src-tauri/Cargo.toml real_model_insert_figure_harness -- --ignored --nocapture
```

前提:

- 先在应用 AI 设置里保存可用的 chat provider/model/API key/base URL;harness 读取同一份 `get_ai_config` 配置。
- 这是真实网络调用,不会随普通 `cargo test` 自动运行。
- 输出会打印每轮 assistant 文本、tool call 参数、tool result 和最终 preview,适合调工具提示词与 schema。
- 源码入口:`src-tauri/src/ai/commands.rs` 的 `real_model_insert_figure_harness`。

## 相关源码
- `design/src/app/hooks/useAiAgent.ts`(`runAgentLoop` / `runLegacyTurn` / `sendPrompt` / `stop` / `retry`)
- `design/src/app/lib/ai-tools.ts`、`design/src/app/lib/story-agent.ts`
- `design/src/app/components/AiMessageBubble.tsx`
- `src-tauri/src/ai/commands.rs`(`append_ai_agent_trace` / `get_ai_agent_trace_path`)
