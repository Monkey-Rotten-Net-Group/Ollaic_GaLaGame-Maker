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

用户消息可包含 `attachments`:随这条消息发出的参考资料(文件名、行数、大小),详见[参考资料上传](./reference-uploads.md)。

写入是 best-effort:localStorage 不可用、隐私模式或配额满时只在 console 警告,不阻塞编辑器渲染。删除会话会移除对应 `ai-session-*` key;索引为空时自动创建一个新会话。

## 历史截断

Agent 循环只纳入最近 8 轮用户/助手对话以适配上下文窗口;超过 500 字的助手消息会被摘要。
- 实现:`truncateContextMessages`(`story-agent.ts`)。

## 项目记忆

项目记忆通过对话标题栏的记忆按钮进入独立管理页,路由为 `/editor/:projectId/memory`。管理页支持新增、编辑、删除、启用/停用,并可按内容、分类、最近修改来源和状态筛选。

记忆按条目保存在项目的 `game/ai-memory.json` 中。条目包含 `id/category/content/enabled/source/createdAt/updatedAt`,分类为世界观、人物约束、剧情事实、写作风格、创作偏好和创作约束。`source` 表示最近一次修改来自用户还是 Agent。启用的条目会注入提示词,停用条目保留在项目中但不参与创作上下文。

支持工具调用的 Agent 可自主调用 `add_memory`、`update_memory` 和 `delete_memory`,调用成功即落盘,无需随剧情变更审批。提示词要求仅保存用户确认的长期事实和偏好,避免保存待审批剧情、临时任务和重复信息;修改和删除前通过 `read_memory` 获取条目及版本。记忆操作会显示在对话工具记录中。legacy 供应商仍只读取记忆上下文,不支持自主维护。

后端在项目锁内完成逐条读改写,使用现有的原子文件保存机制。编辑和删除支持 `expectedUpdatedAt` 冲突检查,失败时管理页保留输入并允许刷新重试。旧版 `worldSetting/writingStyle/userPreferences` 会显示为三个对应分类的条目,首次条目操作时迁移;保留旧字段以兼容旧读取流程。空条目列表不会重新导入已删除记忆。

## 相关源码
- `design/src/app/hooks/useChatSession.ts`
- `design/src/app/lib/project-memory.ts`
- `design/src/app/components/ProjectMemoryPage.tsx`
- `src-tauri/src/webgal/memory.rs`
- `design/src/app/lib/story-agent.ts`(历史截断)
