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
| 写 | `edit_scene` | 暂存对场景的修改 |
| 写 | `create_scene` | 暂存新建场景 |
| 写 | `edit_character` | 暂存角色修改 |
| 写 | `edit_memory` | 暂存项目记忆修改 |

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

## 相关源码
- `design/src/app/hooks/useAiAgent.ts`(`runAgentLoop` / `runLegacyTurn` / `sendPrompt` / `stop` / `retry`)
- `design/src/app/lib/ai-tools.ts`、`design/src/app/lib/story-agent.ts`
- `design/src/app/components/AiMessageBubble.tsx`
- `src-tauri/src/ai/commands.rs`(`append_ai_agent_trace` / `get_ai_agent_trace_path`)
