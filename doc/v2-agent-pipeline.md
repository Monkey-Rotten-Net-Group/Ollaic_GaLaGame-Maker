# V2 — 端到端 Agent 形态

> 把 Ollaic 从「AI 辅助编辑器」重塑为「一次性生成 + Flow 可视化」的端到端 Agent。本文档是 V2 的产品与架构基线；每个落地切片落地后再补对应 `doc/<模块>/` 子文档。

> 与 `WEBGAL_PRD.zh-CN.md` 中 V2 增强的关系：本文属于**重塑产品形态**的另一条主线（AGENT V2），与 PRD 5.3 中列举的可视化分支增强、TTS 等增强项**并行推进**。模板市场先作为后续方向记录；V2 核心先支持 Flow Template / Flow Module 的本地创建、导入、导出与复用。

---

## 1. 一句话目标

用户输入提示词（题材、风格、长度、女主数、语言）→ 系统自动跑完一条**可视化 Flow** → 输出一份可玩 WebGAL 项目。过程中每个 step 可**暂停、干预、重跑**，任意时刻 Flow 画布真实反映执行状态。

---

## 2. 三个范式转变

| 当前 0.1（辅助编辑器） | V2（端到端 Agent） |
|---|---|
| 多轮对话循环（`MAX_TURNS=6`） | 一次性 DAG 编排，无人值守 |
| 散落 change set + 聊天消息 | **StoryPlan IR** 记录生成意图、上下文与运行历史；WebGAL 项目文件仍是可玩内容事实源 |
| 单体 LLM + 工具循环 | 多 Agent 分工（Worldbuilder / Plotter / Dialogist / AssetPlanner / Reviewer） |
| 用户从 AssetManager 挑资产 | **AssetTaskQueue** 自动生成 + 自动绑定 + 自动验收 |
| 聊天气泡显示状态 | **Flow 画布**为主视图 |

---

## 2.1 目标态产品模型

V2 的产品定位是 **AI Galgame Production Studio**：用户通过可复用的 Agent Flow 生产 WebGAL 视觉小说，再用现有编辑器进行检查、修复和精修。它不是「WebGAL IDE + AI Copilot」，也不是把 WebGAL 文件降级成纯导出产物。

目标态是 **Studio Complete**：应用不仅生成一次性的可玩 Demo，而是支持把项目推进到接近发布候选的完整生产状态，并能在后续持续维护、重跑、替换资产、审阅修复、预览和导出。

V2 是 **local-first**：Project、素材、Flow history、AI 配置、Creator Preference 和 Flow Artifact 默认存储并受控于本机。云端能力只作为后续可选同步、备份、分享或模板分发，不作为项目事实源。

Agent Flow 以单 Project 为核心边界。未来可以有批量生产能力，但批量只是编排多个 Project Flow；单个 Flow 不同时拥有多个 Project 的可玩内容事实源。

V2 是 WebGAL-first：WebGAL 是首发和当前主要 Target Engine。StoryPlan、Flow Template、Asset Coverage、Narrative Quality 等生产概念尽量保持引擎无关；WebGAL 语法、运行时预览、导出和引擎专项 Quality Gate 放在 Target Engine 边界内。

### 用户入口：Prompt-first，Template-driven

用户先输入 **Production Brief**（题材、类型、篇幅、女主数、语言、资产/配音要求等），系统将 brief 匹配到一个可审阅的 **Template Match**：

1. 推荐一个主 **Flow Template**；
2. 解释为什么匹配；
3. 识别需要附加的 **Flow Module**；
4. 展示可配置参数；
5. 展示所需 **Model Capability** 与本地 provider 配置之间的缺口；
6. 展示 Content Rating / provider policy risk 与模板兼容性；
7. 允许用户更换模板、调整参数、配置模型、接受降级、禁用模块、覆盖内容分级建议、修改 pending 依赖后再运行。

Template Match 与后续 Agent Flow 可以参考 Creator Preference：用户级偏好影响新项目默认值，项目级偏好影响当前作品的风格、节奏、视觉方向、音色和常见拒绝模式。偏好必须可见、可编辑，不作为隐藏记忆黑箱。

Creator Preference 可以由用户手动填写，也可以由系统根据接受、拒绝、重生成、手动编辑等行为提出建议；建议必须经用户确认后才保存，不能隐藏自动生效。

### 题材与类型

- **Story Subject（题材）**：校园、赛博朋克、奇幻、古风、末日等，主要影响世界观、美术风格、角色设定和语言风格。
- **Production Type（生产类型）**：恋爱路线、悬疑推理、多结局、短篇 Demo、长篇商业作等，可以选择或改变 Flow 结构。

复杂 brief 采用「主 Production Type + Flow Module」组合，而不是多个模板直接合并。例如「赛博朋克校园恋爱悬疑多结局短篇 Demo」可以选择「短篇 Demo」或「悬疑多结局」作为主模板，再附加恋爱路线、线索追踪、多结局可达性等模块。

### Flow Template / Module 的边界

- **Flow Template** 是可复用的生产配方，定义 step、依赖、默认 prompt、输出 schema、参数和专家设置。
- **Flow Module** 是可复用扩展，为副生产类型增加 step、检查、参数或依赖。
- 两者都是生产方式，不是 playable story、WebGAL runtime theme、项目骨架或任意代码插件。
- 默认格式是**声明式配方**：描述 step、依赖、prompt、schema、参数、模型偏好、重试策略和质检规则，不执行任意代码。
- Template / Module 不绑定具体模型名，只声明 **Model Capability**（长上下文、结构化输出强、低成本、强推理、图像生成、TTS 等）；用户本地 provider 配置负责把能力映射到具体模型。
- 用户可以接受能力降级继续运行；普通 step 降级后显示 warning，关键 Quality Gate 不能依赖降级能力被视为完全通过。
- Template / Module 可以声明 **Content Rating** 与 provider policy risk（成人向、暴力、恐怖、敏感主题等）；Template Match 阶段向用户提示风险，但 Ollaic 不承担平台级内容审核职责。
- 单语言创作的目标语言是 Template Parameter；多语言交付通过 Localization Module 增加翻译、术语一致性和语言专项审查 step。
- V2 目标先支持本地创建、保存、导入、导出和复用 Flow Template / Module。
- **Flow Marketplace** 只作为后续方向写入路线图；在模板格式、质量标准、兼容策略和用户需求稳定前，不作为 V2 核心承诺。

### 可玩等级

V2 不把「可玩」视为单一成功状态，而是分为三档：

| 等级 | 含义 | 允许的问题 |
|---|---|---|
| Draft Playable | 可本地粗略试玩，用于尽早感受节奏和结构 | 降级 warning、素材缺失、非阻断质量问题 |
| Review Playable | 指定范围（如第一章）能完整打通，用于人工审阅 | 非关键素材或风格问题 |
| Release Candidate | 导出候选，关键 Quality Gate 必须通过 | 不允许阻断性脚本/跳转问题，不允许关键 Gate 依赖降级能力 |

用户在 StoryEditor、AssetManager、CharacterPanel 等现有编辑器里手动修改可玩内容后，受影响的 Flow Step 会标记为 stale；当前 Playability Level 必须降级或显示「需重新验证」，直到相关 Quality Gate 重新通过。

影响范围优先基于引用追踪精确计算：例如 scene 文件改动影响对应 Scene Step 及其下游资产、审查、导出检查；素材或角色改动影响引用它们的 scene 和相关 Quality Gate。若无法可靠追踪影响范围，FlowBoard 必须保守地扩大 stale 范围。

Flow 运行中使用分区锁：正在运行的 step 涉及的 scene / asset / character / record 暂时只读，其他不相关内容仍可编辑。用户对未锁定内容的修改会按 Flow Impact 标记 stale，避免全项目锁死，也避免与自动写入产生竞态。

当章节、scene、角色设定或对白被重写时，相关资产和语音不会被自动删除；系统基于引用追踪标记为 Stale Asset，并提供复用、重绑、重生成或用户删除的路径，避免旧媒体悄悄挂在新剧情上。

当用户替换角色设计、视觉风格、音色或其他资产定义上下文时，系统生成 Asset Consistency Task 队列，建议哪些表情、CG、语音或场景资产需要重生成 / 重绑 / 复查；用户选择执行范围，不自动覆盖所有相关资产。

Asset Coverage 随 Playability Level 提供默认值，并可作为 Template Parameter 调整：Draft Playable 可以只生成占位或关键资产，Review Playable 应覆盖主要角色/场景，Release Candidate 才追求完整背景、立绘、语音或音乐覆盖。

Release Candidate 采用分层完整度：Primary Play Path 需要完整背景、必要立绘、BGM/SFX、关键 CG 与语音覆盖；支线或低优先级内容可以降级或占位，但 FlowBoard 和 Quality Report 必须明确标记覆盖缺口。

Primary Play Path 由系统根据 Flow Template、Production Brief 和分支图推荐，用户可在 FlowBoard / 路线视图中审阅和修改；模板也可以声明默认选路规则。

Release Candidate 的检查范围由 **Release Scope** 决定：可以是一个主结局、全部结局、指定章节或用户选择的路线集合。Quality Gate 与 Asset Coverage 按 Release Scope 执行，而不是默认要求所有分支同等完整。

导出支持 full export 与 Scoped Export。Scoped Export 只包含 Release Scope 所需内容，但必须先验证 scene / asset / variable / branch 引用安全，不能简单删除范围外文件导致 WebGAL 项目损坏。

### 审阅而非多人协作

V2 支持本地 Review Note：用户可以在 Flow Step、Quality Report、scene、asset、character 上留下评论、待办或修复标记，用于人工审阅和后续修复。多人实时协作、共享权限和冲突同步不属于核心目标态。

Review Note 有 severity：info / warning / blocker。blocker 会阻止 Project 达到 Release Candidate，直到被解决或用户显式降级；warning 不阻断，但必须在 FlowBoard 和 Quality Report 中可见。

Reviewer Agent 发现问题时可以生成 Review Note 与 Review Patch。Review Patch 需要可预览、可拒绝、可应用；Run to Playable 模式下可允许低风险修复自动应用，但高风险修复仍需用户确认。

低风险自动修复由 Auto-Fix Policy 决定：系统定义安全上限，Flow Template / Flow Module 只能在安全上限内声明更具体的自动修复策略，不能把危险或大范围重写伪装成低风险。

初始安全上限只覆盖机械可验证修复：补全元数据、格式化、artifact 标记、可验证的 asset reference 更新、voice card / asset metadata 补全等。自动修复不得删除内容、改剧情语义、重排分支或改变量逻辑。

### 优先用户

近期优先服务两类用户：

1. **非程序个人创作者**：需要低门槛 Production Brief、清晰的 Template Match、可渐进推进的 Playability Level，以及尽快得到 Draft Playable。
2. **高级 AI 创作者 / 同人制作人**：需要可审阅 Flow、可配置参数、模型能力映射、导入/导出 Flow Template / Module、可追溯 run history。

小型工作室协作、模板作者生态和 Flow Marketplace 先作为后续方向，不驱动近期最小闭环。

优先用户不降低目标完整度：即使近期先服务个人创作者和高级 AI 创作者，目标态仍要求完整 GAL 生产能力，包括剧情、分支、角色、场景、背景/CG/立绘、BGM/SFX、语音、自动绑定、质检、审阅修复、试玩和导出候选。

## 3. 八个新增模块

### 3.1 Pipeline Orchestrator ⭐ 编排核心

**作用**：声明式定义生成 Flow 的 DAG，调度 step 执行，处理依赖 / 重试 / 跳过 / 暂停 / 续跑，并作为事件源推送给前端。

**目标源码**：
- `src-tauri/src/pipeline/pipeline.rs` — 核心 scheduler
- `src-tauri/src/pipeline/pipeline_dsl.rs` — Step DSL 解析
- `src-tauri/src/pipeline/pipeline_state.rs` — 状态机 + 持久化（`.ollaic/pipeline/<runId>.json`）
- `src-tauri/src/pipeline/pipeline_events.rs` — 事件总线（`tokio::broadcast`）

**新增 IPC**：`pipeline_start / pipeline_pause / pipeline_resume / pipeline_retry_step / pipeline_event`（订阅）

**用户可见**：Flow 画布上的「运行 / 暂停 / 从 step K 重跑 / 跳过 step」。

**验收**：每 step 的开始 / 结束 / 失败 < 1 s 推到前端；应用异常关闭后能从最后未完 step 续跑，不重做已完成部分。

---

### 3.2 StoryPlan IR ⭐ 领域核心

**作用**：项目级「生成计划」中间表示，记录 Production Brief、Template Match、step 输入输出、上下文摘要和运行历史，可序列化、可校验、可视化。StoryPlan 用于解释和恢复生成过程；实际可玩的故事仍由 WebGAL 项目文件、角色记录和素材文件决定。

**目标位置**：`.ollaic/plan.json`，由 `src-tauri/src/story_plan/` 维护。

**字段草案**：

```ts
interface StoryPlan {
  version: 1;
  prompt: string;                  // 用户原始提示词
  synopsis: string;
  memory: {
    worldbook: string;             // 长文世界观（Worldbuilder 产出）
    glossary: Record<string, string>; // 专有名词表
  };
  chapters: ChapterPlan[];         // 章节
  characters: Character[];         // 角色卡
  branches: BranchGraph;           // 分支图
  assetPlan: AssetTask[];          // 资产任务（详情见 3.5）
  pipelineRuns: PipelineRunSummary[]; // 历史运行
}
```

**验收**：Pipeline 启动前 schema 校验；任意 step 失败时能从 IR 还原完整上下文。

每次 step 尝试都保留 **Step Run History**：输入快照、输出引用、diff、cost、duration、warning / downgrade、失败摘要等。长日志、图片、音频和大文本产物以 artifact 引用形式保存，并需要后续清理策略，避免 `.ollaic` 无限增长。

历史清理策略：默认保留最近 N 次 step 尝试；用户可以 pin 重要 run 防止自动清理，也可以手动清理或导出历史与 artifact。

---

### 3.3 Multi-Agent（多角色分工）

**作用**：单 LLM 写不出 5w–10w 字一致性作品。按职责拆分，每个 Agent 独立 system prompt / 上下文裁剪 / 模型路由。

**当前源码**：
- `src-tauri/src/agents/plan.rs`
- `src-tauri/src/agents/memory.rs` — Worldbuilder 职责
- `src-tauri/src/agents/outline.rs` — Plotter 职责
- `src-tauri/src/agents/character.rs`
- `src-tauri/src/agents/dialogist.rs`
- `src-tauri/src/agents/asset_planner.rs`
- `src-tauri/src/agents/scene.rs` — 确定性 SceneScript 编译
- `src-tauri/src/agents/router.rs` — 按 step 路由到合适 Agent + 模型

**模型路由建议**：

| Agent | 偏好 | 备选 |
|---|---|---|
| Worldbuilder | 长上下文 | 中等价即可 |
| Plotter | 结构化输出强 | — |
| Dialogist | 创意强 | 中等价即可 |
| AssetPlanner | 结构化输出 | 视觉语言可外接 |
| Reviewer | 长上下文 + 强推理 | — |

P1 已实现前六类内容职责；Reviewer 属于 P3 Quality Gate。各 Agent 通过 `AgentRegistry` 被 pipeline 独立调用，新增 Agent 无需修改 Orchestrator。

#### 结构化输出边界（P1 已实现）

- OpenAI / DeepSeek 内容 Agent 请求启用 JSON Mode，先约束为合法 JSON。
- 响应必须通过 Rust `serde` 类型校验；字符串中的未转义控制字符由解析器确定性转义。
- 类型校验失败时，携带原上下文、原响应和校验错误自动修复一次；仍失败则 Flow Step 失败，不写入 StoryPlan。
- Agent 自身继续执行场景覆盖、角色完整性、脚本可编译性等语义校验。
- JSON Mode 不保证 Schema 或内容正确。只有明确支持 strict JSON Schema 的 provider 才能增加生成阶段的 Schema 约束；无论 provider 能力如何，应用侧校验不得省略。

---

### 3.4 Flow 可视化画布 ⭐⭐ 用户最大改变

**作用**：取代当前 ProjectHome / StoryEditor 的首屏地位，所有交互从这张画布发出。

**目标组件**：
- `design/src/app/components/FlowBoard.tsx` — 画布主视图（候选 React Flow 或自研轻量方案）
- `design/src/app/components/StepNode.tsx` — 节点渲染（status / 名称 / 进度 / 摘要 / cost 角标）
- `design/src/app/components/FlowToolbar.tsx` — 运行 / 暂停 / 重跑 / 跳转
- `design/src/app/components/StepDetailDrawer.tsx` — 点击节点看 prompt / 输出 / 日志 / diff / 重试
- `design/src/app/components/FlowEventStream.tsx` — 实时事件流（订阅 `pipeline_events`）
- 复用并升级现有的 `MiniNodeCard.tsx` / `PerformanceTimeline.tsx`

#### 节点类型 / 状态

| 类型 | 触发来源 | 状态机 |
|---|---|---|
| Plan | 用户提示 → 概述 | `pending · running · succeeded · failed · awaiting-input` |
| Memory | 长文世界观 | 同上 |
| Outline | 章节 / 分支 | 同上 |
| Character | 单个角色 | 可并行 |
| Scene | 单个场景脚本 | 可并行，依赖前置 chapter |
| Asset | 资产队列父节点 | 内部折叠列表 |
| Lint | 静态检查 | 单次 |
| Review | AI 自审 | 单次 |
| Export | 打包 | 单次 |
| UserInput | 暂停等用户补充 | 触发点 |

**用户行为清单**：

| 操作 | 反馈 |
|---|---|
| 点节点 | 抽屉显示 step 详情、prompt、输出摘要、cost、duration |
| 拖节点 | 改变 DAG 依赖（仅 pending 内生效，已运行节点只读） |
| 右键节点 | 重跑 / 跳过 / 编辑 prompt 重跑 / 跳到目标 scene / 资产 |
| 画布操作 | 滚轮缩放、拖动平移 |
| 工具栏 | 推进到下一可玩等级 / 暂停 / 停止 / 续跑 / 时间倒带 |
| 顶栏 | 当前 IR 摘要、总体进度、token 总成本、当前 runId |

FlowBoard 的主按钮随当前状态变化：初始为「生成草稿试玩」，Draft Playable 完成后变为「推进到审阅版」，Review Playable 完成后变为「推进到发布候选」。用户仍可在高级操作中选择运行单个 step、从某 step 重跑或跳过 pending step。

**与现有 UI 的关系**：

| 现状 | V2 中去向 |
|---|---|
| `StoryEditor.tsx` | 双击 Scene 节点打开 |
| `AssetManager.tsx` | 双击 Asset 节点打开 |
| `CharacterPanel.tsx` | 双击 Character 节点打开 |
| `SceneGraph.tsx` | 删除或并入 FlowBoard 的迷你预览 |
| `ProjectHome.tsx` | 替换为 FlowBoard 的项目首屏 |

**验收**：10w step 不卡顿（虚拟化）；暂停 / 续跑 / 单步重跑均可用；节点状态与真实 step 同步延迟 ≤ 1 s。

---

### 3.5 AssetTaskQueue ⭐ 资产闭环（P2 已实现）

**作用**：把 image / TTS 的生成调用与手动音频任务统一纳入队列，自动绑定到 scene / character，自带重试 / 验收。

**目标源码**：
- `src-tauri/src/asset_queue/types.rs` / `store.rs` — 状态机与 `.ollaic/assets/queue.json` 持久化
- `src-tauri/src/asset_queue/scheduler.rs` — 并发池（默认 2 image + 4 tts + 1 audio，可配置）
- `src-tauri/src/asset_queue/binder.rs` — 按 `AssetTask.sceneRef` 自动写到 `game/background/*`、`game/figure/*`、`game/bgm/*`、`game/vocal/*`，并更新脚本引用
- 可选 AI 自评（构图、口型匹配、风格一致）留到质量评估需求明确后接入，不属于 P2 阻断项

**收敛现有能力**：`ai_generate_image / ai_generate_tts / generate_batch_tts` 收敛为队列单一入口；BGM/音效保持本地导入。

**用户可见**：Flow 画布上 Asset 节点展开后是进度列表，每条资产显示 prompt / 缩略图 / 重试次数 / 绑定 scene。

**验收**：12 场景 × 平均 8 段对白，30 分钟内完成全部语音；失败自动 retry 3 次再标 failed；自动绑定成功的生成产物进入正式素材库并写入 scene 引用；失败、候选、重试产物保留为 Flow Artifact，可预览、清理或手动提升为正式资产。

---

### 3.6 Quality Gate（自动质检 + 自审）

**作用**：在 Export 前必须有自动关卡挡住致命问题。

**目标源码**：
- `src-tauri/src/quality/lint.rs` — WebGAL 语法 / 未声明变量 / 跳转死链 / 孤立场景 / 可达性 / 选项无下游
- `src-tauri/src/quality/auto_review.rs` — 调 Reviewer Agent 做一致性 / 风格 / 伏笔检查
- `src-tauri/src/quality/report.rs` — 生成质量报告

**用户在 Flow 上看到**：Quality 节点显示 ✅ / ⚠ N 项；点击跳到修复面板。

**验收**：每次 Export 前自动跑；阻断性问题不可绕过；关键 Quality Gate 如果使用了降级能力，不能显示为完全通过，必须要求用户补配能力、重跑或显式接受风险进入非发布级预览。

Narrative Quality 目标是生产级：不只检查文本可读，还要检查角色口吻、风格一致、术语一致、节奏、伏笔、分支动机、情绪曲线和玩家选择反馈。Draft Playable 可先做轻量检查，Review Playable / Release Candidate 逐步加严。

Release Candidate 可以被结构性叙事问题阻断，例如分支缺乏动机、角色严重 OOC、必要伏笔未回收、情绪弧断裂、玩家选择缺少反馈等；主观审美建议默认作为 warning。Flow Template 可在系统质量门分类内调整阈值。

---

### 3.7 One-Click Run & Play（一键可玩）

**作用**：Flow 末尾自动 export → 起 Runtime Server → 用内嵌 Webview 打开预览。

**目标源码**：复用 `webgal/runtime_server.rs` + `webgal/project::export_project`，新增 `pipeline/finalize.rs` 收尾。

**用户可见**：全部 step 变绿后弹「试玩」按钮；点击进入 Runtime 窗口。

---

### 3.8 Observability & Cost（可观测 + 成本）

**作用**：让用户清楚每步花多少钱、为什么慢、能不能优化。

**目标源码**：
- `src-tauri/src/telemetry/usage.rs` — token 消耗、模型、时延
- `src-tauri/src/telemetry/cost.rs` — 按 provider 单价估算（表驱动）

**用户可见**：节点右上角角标显示 cost / duration；总览面板给预计成本、实际成本、总耗时、失败率。成本默认只做透明展示，不作为自动暂停或阻断条件。

---

## 4. 数据流总图

```
                ┌──────────────────────────────────────────────┐
                │              FlowBoard (React)               │
                │   DAG 渲染 / 状态镜像 / 用户操作              │
                └──────────────┬───────────────────────────────┘
                               │ Tauri event / IPC
                               ▼
       ┌────────────────────────────────────────────────────┐
       │   Pipeline Orchestrator (Rust, tokio)              │
       │   DAG 调度 / 重试 / 持久化 / 事件总线              │
       └───┬───────────┬───────────┬─────────────┬──────────┘
           ▼           ▼           ▼             ▼
        WorldBuilder  Plotter   Dialogist ...  Reviewer
           │           │           │             │
           └─────┬─────┴─────┬─────┘             │
                 ▼           ▼                   │
            ┌──────────────────────┐             │
            │       StoryPlan IR   │◄────────────┘
            │  .ollaic/plan.json   │
            └──────────┬───────────┘
                       ▼
              ┌────────────────────┐
              │  AssetTaskQueue    │
              │  image / tts / bgm │
              └─────────┬──────────┘
                        ▼
                  game/ (WebGAL)
                        ▼
                  Runtime Server → 试玩
```

---

## 5. 验收门槛（V2 上线标准）

| 维度 | 指标 |
|---|---|
| 端到端 | 任意提示词 → 12 场景 / 3 角色 / 中文 → 全部跑完 ≤ 30 min |
| 过程可视化 | Flow 画布节点状态与真实 step 同步延迟 ≤ 1 s |
| 干预能力 | 任意 step 可暂停、可重跑、可注入用户修订 |
| 资产闭环 | ≥ 80% 资产自动绑定，无需人工挑选 |
| 质检 | Export 前必跑 lint + AI 自审，致命问题阻断 |
| 可玩性 | 一键试玩，进入 Runtime 后能完整打完第一章 |
| 成本 | 单作品产出阶段 token 等效花销 ≤ $5（GPT-4.1 mini 估算） |
| 续跑 | 关闭应用再启动，能从最后未完 step 继续，不重做已完成部分 |

---

## 6. 落地切片（建议 4 个迭代）

| 切片 | 内容 | 价值锚点 |
|---|---|---|
| **P0 — Flow Shell（已完成）** | Pipeline Orchestrator + StoryPlan IR + FlowBoard + 2 个内置确定性 step（Plan + Outline） | 项目以 FlowBoard 为入口，DAG 状态、干预和崩溃恢复已闭环 |
| **P1 — 内容链路（已完成）** | Plan → Memory → Plotter → Character → Dialogist → AssetPlanner → SceneScript | 「Production Brief → 可编辑 WebGAL」闭环 |
| **P2 — 资产闭环（已完成）** | AssetTaskQueue + 自动绑定 + 并发限流 | 生成候选经 Artifact 晋升为正式素材并写入 Scene / Character 引用 |
| **P3 — 试玩 & 自审** | Quality Gate + One-Click Run & Play + Reviewer Agent | 端到端可玩 + 可信赖 |

P0 是地基，其余切片可以基于 P0 并行。**强烈建议先实现 P0**，否则后续每个功能都要 hack 状态。

---

## 7. 待跟踪决策

落地 P0 前需要明确的事项：

- [x] Flow 画布技术栈：React Flow（ADR 0053）
- [x] IR 落盘格式：JSON（ADR 0054）
- [x] Pipeline 持久化粒度：每 step 状态转换一次（ADR 0054）
- [x] 事件总线传输：Tauri event（ADR 0055）
- [x] P1 多 Agent 上下文按职责显式投影；长篇作品的动态裁剪留待质量与成本测试后扩展
- [x] AssetTaskQueue 默认按能力分别限流：2 image / 4 TTS / 1 audio，队列持久化且可继续运行
- [ ] Quality Gate 中的「致命 vs 警告」分级阈值
