# 会话与记忆

## 多会话

对话**按项目**持久化到浏览器 WebView 的 `localStorage`,而非项目文件或 Tauri 配置目录,也不是按场景保存。每个会话有标题、创建/更新时间,并保留最近约 40 条消息;旧的「按场景」存储会自动迁移。切换会话无缝,**待确认变更可跨场景保留**。

- 会话管理 UI(在 `StoryEditor.tsx` 的会话下拉菜单):新建、切换、重命名、删除会话。重命名为应用内输入,删除有确认对话框。
- 每个新会话带一条中文开场白,说明助手能力(`INITIAL_AI_MESSAGE`)。
- 实现:`useChatSession.ts`。

### localStorage 结构

`projectId` 由编辑器路由传入,未打开真实项目时使用 `demo` 作为 fallback。当前结构:

| Key | 内容 |
|-----|------|
| `ai-sessions-${projectId}` | 会话索引:`{ activeId, sessions[] }`,其中每个 session 记录 `id/title/createdAt/updatedAt` |
| `ai-session-${projectId}-${sessionId}` | 单个会话正文:`{ messages, lastUpdatedAt }` |
| `ai-chat-${projectId}-*` | 旧版按场景历史;首次加载时 best-effort 迁移到新结构 |

`messages` 中只保存用户/助手消息,会过滤掉固定开场白。助手消息可包含:
- `content`:当前显示文本
- `steps`:多步 Agent 每一轮的文本与工具调用摘要
- `diff`:用户同意修改后附带的文本 diff
- `stopped`:中断标记

写入是 best-effort:localStorage 不可用、隐私模式或配额满时只在 console 警告,不阻塞编辑器渲染。删除会话会移除对应 `ai-session-*` key;索引为空时自动创建一个新会话。

## 历史截断

Agent 循环只纳入最近 8 轮用户/助手对话以适配上下文窗口;超过 500 字的助手消息会被摘要。
- 实现:`truncateContextMessages`(`story-agent.ts`)。

## 项目记忆

`AiMemoryPanel` 提供三个可编辑字段,保存后按项目持久化,并注入到 Agent 与 legacy 提示词:
- **世界观 / 设定(worldSetting)**
- **文风(writingStyle)**
- **用户偏好(userPreferences)**

面板有「未保存」红点提示。
- 模型:`lib/project-memory.ts`;UI:`AiMemoryPanel.tsx`。

## 相关源码
- `design/src/app/hooks/useChatSession.ts`
- `design/src/app/lib/project-memory.ts`
- `design/src/app/components/AiMemoryPanel.tsx`
- `design/src/app/lib/story-agent.ts`(历史截断)
