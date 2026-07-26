# 对话编辑 Agent

AI 助手通过多轮对话理解项目上下文，读取场景、素材、角色和项目记忆，并把脚本或设定修改暂存为变更预览。用户确认后才会写入文件。

## 0.1 能力

- 支持 function-calling 供应商的多步工具循环；不支持工具调用的供应商走 legacy 单轮 JSON patch 兜底。
- 读工具：列出场景、读取场景、搜索素材、读取角色、读取项目记忆、列出/读取用户上传的参考资料。
- 写工具：设置场景章节/大纲、插入剧情块、创建分支、编辑场景、插入立绘、创建场景、创建/编辑角色、规划角色表情、规划背景/CG、编辑项目记忆。
- 高层故事工具优先使用结构化输入，减少模型直接手写 WebGAL txt 的失败面。
- 所有写入先进入 change-set；用户可接受或拒绝，冲突时保留手动处理入口。
- 每轮 Agent 执行会写 best-effort trace，便于排查工具调用与 staging 失败。

## 约束

- AI 不直接删除角色或素材。
- 缺失背景/CG 时先规划待生成素材，再允许脚本引用规划出的目标文件名。
- 缺失立绘时只规划角色表情槽，不编造 `changeFigure` 文件。
- 当前上下文会截断：保留当前场景、最近对话、素材摘要、项目记忆和参考资料清单的关键部分；参考资料正文按需分页读取，不整篇注入。
- 参考资料只读：AI 可以取材，但不能据此直接改动可玩文件，落地仍走写工具 + change-set。详见[参考资料上传](./reference-uploads.md)。

## 状态

| 状态 | 含义 |
|------|------|
| `idle` | 等待输入 |
| `generating` / `tooling` | 模型生成或调用工具 |
| `pending` | 有变更等待用户确认 |
| `accepted` / `reverted` | 用户已接受或拒绝 |
| `conflict` | 当前文件和预览基础不一致 |
| `error` | 供应商、网络或 staging 出错 |

## 调试

- 普通 AI 调用日志：`ai-log.jsonl`。
- Agent 工具 trace：`ai-agent-trace.jsonl`，位于 Tauri 配置目录。
- 真实模型 harness 是 ignored Rust test，只在手动指定 `--ignored --nocapture` 时运行。

## 相关源码

- `design/src/app/hooks/useAiAgent.ts`
- `design/src/app/lib/ai-tools.ts`
- `design/src/app/lib/story-agent.ts`
- `design/src/app/lib/ai-uploads-ipc.ts`
- `design/src/app/components/AiMessageBubble.tsx`
- `src-tauri/src/ai/commands.rs`
- `src-tauri/src/ai/commands_tests.rs`
