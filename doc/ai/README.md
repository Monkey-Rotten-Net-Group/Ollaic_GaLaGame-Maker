# AI 子系统

Ollaic 有两条 AI 工作流：FlowBoard 中的 **Production Agent Flow** 负责从 Production Brief 端到端生成可编辑 WebGAL；编辑器中的**对话式创作助手**负责局部读取、修改和预览。除此之外，还支持 AI 生成图像（背景/CG/立绘）与语音（TTS）。

## 子文档

| 文档 | 内容 |
|------|------|
| [对话编辑 Agent](./conversational-agent.md) | 多步 function-calling 循环、可用工具、legacy 单轮兜底、状态机、流式与重试 |
| [修改预览与应用](./change-preview.md) | 变更集(change-set)、节点级 diff、冲突处理、缺失素材、事务落盘与恢复 |
| [会话与记忆](./sessions-and-memory.md) | 多会话(按项目持久化)、历史截断、项目记忆(世界观/文风/偏好) |
| [参考资料上传](./reference-uploads.md) | 上传本地文本供 AI 取材、存储位置与安全边界、只读参考工具 |
| [AI 素材与立绘生成](./media-generation.md) | 图像生成、TTS 语音生成、进度反馈、分模态配置 |
| [供应商与模型配置](./providers.md) | Chat/Image/TTS 三类供应商与模型、连接测试、调用日志 |

## 总览

- **Production Agent Flow**：Rust 后端按 Plan → Memory → Plotter → Character → Dialogist → AssetPlanner → SceneScript → AssetTaskQueue 执行，当前完成 P2 资产闭环；详见 [`../v2-agent-pipeline.md`](../v2-agent-pipeline.md)。
- **入口**:编辑器右侧 `AiAssistantPanel`(会话标题 + 状态徽标 + 输入框)。
- **核心 Hook**:`useAiAgent`(状态机)、`useChatSession`(会话存储)。
- **两种执行模式**:支持原生函数调用的供应商走**多步 Agent 循环**(读工具→写工具→暂存);其余供应商走 **legacy 单轮**(一次性返回 JSON 补丁)。
- **安全应用**:AI 的写操作只产出「暂存变更」,经用户在变更卡片中**同意**后才原子写入磁盘;**拒绝**则丢弃。
- **参考资料**:用户上传的本地文本存放在项目编辑器状态目录,AI 只能**只读**取材,不进入 `game/`,也不绕过变更审批。

## 相关源码

- `src-tauri/src/agents/` — P1 多 Agent 内容生成、结构校验与 WebGAL 编译
- `src-tauri/src/pipeline/` — Agent Flow 编排、恢复、历史与 StoryPlan 更新
- [`../agent-flow-contracts.md`](../agent-flow-contracts.md) — 节点输入输出、引用、校验与恢复契约
- `src-tauri/src/asset_queue/` — P2 资产队列、分类限流、Artifact 与自动绑定
- `design/src/app/hooks/useAiAgent.ts` — AI 状态机与 Agent 循环
- `design/src/app/hooks/useChatSession.ts` — 会话存储
- `design/src/app/lib/ai-tools.ts` — 工具定义与注册表
- `design/src/app/lib/ai-ipc.ts` — 与后端的 RPC(聊天/图像/TTS/配置)
- `design/src/app/lib/ai-uploads-ipc.ts` — 参考资料 RPC 与提示词上下文
- `src-tauri/src/ai/uploads.rs` — 参考资料存储与读取
- `design/src/app/lib/story-agent.ts` — 提示词、上下文构建与截断
- `design/src/app/lib/change-set.ts` — 变更暂存与校验
- AI 组件:`AiAssistantPanel`/`AiInputBox`(在 `StoryEditor.tsx`)、`AiMessageBubble`、`AiPendingCard`、`AiStatusCard`、`AiMemoryPanel`、`AiUploadsButton`、`MiniNodeCard`、`PreviewNodeCard`、`AiSettingsDialog`
