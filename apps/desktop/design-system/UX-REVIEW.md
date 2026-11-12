# Ollaic 桌面端 UI/UX 审查（对照设计系统）

日期：2026-11-02（Asia/Shanghai）
范围：`apps/desktop/src`（路由 `app/routes.tsx` 的 5 个页面：ProjectHome、FlowBoardPage、StoryEditor、ProjectMemoryPage、AssetManager，以及其中的设置、弹窗、AI 助手面板）。
方法：只读代码审查。所有结论都附 `文件:行号`。对比度按 WCAG 2.x 公式，用代码里的实际 token 值计算（半透明值按叠在白色或深色卡片上计算）。**看不到运行画面的行为不做推断**；需要人工确认的地方标了“需目测”。
行号说明：`theme.css`、`ProjectHome.css` 的行号是 P0 改动后的版本（本次已改）；其余文件是当前工作区版本（含你未提交的改动）。

## 摘要

| 级别 | 数量 | 主题 |
|---|---|---|
| 高 | 6 | 焦点可见性、手写弹窗无障碍、低对比文字、无确认的永久移除、原生 alert/confirm、两套明暗开关 |
| 中 | 9 | 组件不统一、10/11px 小字、CJK 粗细失效、点击区域、z-index、toast、动效降级、导航不一致、在线字体 |
| 低 | 5 | ::selection、i18n 残留、空状态样式不一、Loader 不统一、placeholder 对比 |

**已修复**：H1、H4、H5、H6、M6（2026-11-02，见文末“已修复”一节）。

---

## 高

### H1 全局焦点框几乎看不见（1.72:1），且覆盖了正确的焦点样式
- **状态：已修复**（`c353c1c`：新增 `--focus-ring` token，全局只保留一条 `@layer base` 的 `:focus-visible`，对比度 5.01–11.19:1）。
- 证据：`src/styles/animations.css:51-54` 是**不在 layer 中**的 `:focus-visible { outline: 2px solid color-mix(var(--color-warm-glow) 70%, transparent) }`。`src/styles/theme.css:194-201` 位于 `@layer base`（第 111 行开始），给 button/input/textarea/select 的 `var(--ring)` 焦点框会被这条未分层规则覆盖（未分层样式优先于任何 layer）。
- 计算：warm-glow = oklch(75% 0.08 75) ≈ #cca774，70% 叠在白底上，对比 **1.72:1**，低于 WCAG 1.4.11 / 2.4.11 要求的 3:1。用 ring 的版本是 3.28:1，可以达标。
- 另外，非 ui 组件里只有 4 行用了 `focus-visible:`，289 个原生 `<button>` 全靠这条全局规则。
- 修复：删除 animations.css 中的 `:focus-visible`，或改成 `outline: 2px solid var(--ring)`。在 tokens.css 增加 `--focus-ring: var(--ring)`，ui 组件和 `.ollaic-*` 类统一使用。

### H2 手写弹窗缺少对话框语义、Esc 关闭和焦点管理
- 证据：以下 8 个弹窗都是手写的 `fixed inset-0`，没有 `role="dialog"` / `aria-modal`，也没有 Esc 处理和焦点限制：
  - `AppSettingsDialog.tsx:372`
  - `AiSettingsDialog.tsx:266`
  - `ProjectMetadataDialog.tsx:99`
  - `SnapshotManagerDialog.tsx:108`
  - `AssetManager.tsx:2427`
  - `CharacterPanel.tsx:1673`、`CharacterPanel.tsx:1809`
  - `VoiceDubbingPanel.tsx:598`

  Esc 只在这些地方处理过：`ProjectHome.tsx:361`、`FlowBoard.tsx:855`、`ScriptCommandStream.tsx:888`、`SceneWorldline.tsx:77`、`AiAssistantPanel.tsx:208`。
- `ScenePreviewDialog.tsx:84-85` 有 `role`/`aria-modal`，但没有 Esc 处理，也没有焦点管理。
- 正面例子：`FlowBoard.tsx:232-255、853-869` 已经实现了 inert、焦点循环和焦点归还，可以照着做。
- 修复：统一改用 `ui/dialog.tsx` / `ui/alert-dialog.tsx`（Radix 自带焦点限制、Esc、aria）。项目里已有 5 处在用 Radix Dialog（AiAssistantPanel、NewSceneDialog、DetailPanel、AssetPicker、ProjectMemoryPage），参考它们。

### H3 大量半透明次要文字低于 AA
- 证据：`text-muted-foreground/60`×7、`/40`×6、`/50`×3、`/30`×3，`text-on-surface-variant/60`×5、`/30`×2，共 31 处。示例：`ScriptCommandStream.tsx:88`（`text-[9px] … text-on-surface-variant/60`）、`ScriptCommandStream.tsx:305`（`text-[9px] … /50`）。
- 计算（叠在白色上）：
  - muted-foreground #625b70 不透明时 6.09:1，没问题。
  - /60 降到 **2.66:1**，/40 降到 **1.85:1**。
  - 这些文字大多同时是 9–10px，更难读。
- 修复：禁止给文字颜色加透明度。次要层级只用 `text-muted-foreground`（6.09:1）。更弱的装饰性信息改用 `--outline` #867d96（3.90:1，只用于 ≥14px 粗体或非必要信息），或者干脆去掉。

### H4 永久移除项目没有确认
- **状态：已修复**（`9296951`：ProjectHome 使用 `ui/alert-dialog` 二次确认，确认按钮为 destructive）。
- 证据：`ProjectHome.tsx:1129-1132` 的“永久移除”按钮点击后直接调用 `handlePermanentDelete`（`ProjectHome.tsx:571-574`），会从列表中删除并 `localStorage.removeItem('project-path-…')`，没有任何确认或撤销。
- 对比：同类操作“删除会话”有 Radix 确认框（`AiAssistantPanel.tsx:598-616`）。
- 修复：用 `ui/alert-dialog` 二次确认，确认按钮使用 `--destructive`；或在回收站中提供撤销 toast。

### H5 用原生 `alert()` / `confirm()` 做错误提示和危险操作确认
- **状态：已修复**（`5decdc0`：AssetManager、StoryEditor、VoiceDubbingPanel 改用 `useConfirmDialog` 与共享 toast；`useFlowRunController.ts` 的 `window.confirm` 和两处 `prompt()` 未在本次范围内）。
- 证据：
  - `alert`：`StoryEditor.tsx:801、819、881`；`VoiceDubbingPanel.tsx:286、298、304、325`。
  - `confirm`：`AssetManager.tsx:732、759、1069、1113`；`StoryEditor.tsx:785`；`VoiceDubbingPanel.tsx:359`。
- 问题：
  - 系统弹窗不跟随主题和字体，也会阻塞线程。
  - 错误文字直接拼接 `${e}`，可能显示原始异常。
  - 只有 `StoryEditor.tsx` 引入了 `ui/alert-dialog`，确认方式不统一。
- 修复：危险确认统一用 `AlertDialog`；错误用统一的 toast（见 M6）或内联 `role="alert"` 横幅（`ProjectHome.tsx:958` 的 `ph-banner--error` 是现成样式）。

### H6 两套互不同步的明暗开关
- **状态：已修复**（`a2c85e9`：app settings 是唯一主题来源，首页开关写入 app 设置，旧的 `ollaic-home-theme` 被忽略并清除）。
- 证据：
  - 首页有自己的开关：`ProjectHome.tsx:272-286`（`ollaic-home-theme`），作用在 `.ph-root.dark`（`ProjectHome.tsx:715`），按钮在 `ProjectHome.tsx:845-853`。
  - 应用全局主题写在 `<html>`：`app-settings.ts:57-59`、`AppSettingsDialog.tsx:428、445`。默认值 `theme: 'dark'`（`app-settings.ts:19`）。
  - 首页开关只改首页，不改 `<html>`。
- 后果：首页浅色、编辑器深色（或反过来）。在首页打开的设置弹窗渲染在 `.ph-root` 内（`ProjectHome.tsx:1375、1388`），它的 `dark:` 变体跟随 `<html>`，而颜色变量跟随首页。例如 `AiSettingsDialog.tsx:813` 的 `dark:text-emerald-300` 在白底上只有 1.52:1。
- 修复：只保留一个主题来源（`applyAppAppearance`），首页按钮也调用它，并移除 `ollaic-home-theme`。

---

## 中

### M1 组件不统一：原生控件远多于 ui 基础组件
- 证据：
  - 原生 `<button>` 289 个，ui `<Button>` 40 个。
  - 原生 `<input>` 74 个，ui `Input` 0 处使用。
  - 原生 `<textarea>` 23 个、`<select>` 21 个。
  - 同时存在 `.ollaic-icon-button`、`.ollaic-command`（theme.css components 层）、`.ph-*` 按钮，以及大量手写 Tailwind 按钮，例如 `AiAssistantPanel.tsx:579、607` 的 `rounded-md bg-secondary px-3 py-2`。
- 修复：
  - 在 `ui/button.tsx` 的 cva 中加入 `icon-sm`（28px）、`pill`、`ink`（`--ink-button*`）变体。
  - 把 `.ollaic-icon-button`、`.ollaic-command` 变成 Button 的变体。
  - 新增 `ui/input.tsx`、`ui/textarea.tsx`、`ui/select.tsx` 的统一外观（`--input-background`、`--border`、`--ring`）。

### M2 字号过小、档位过多，CJK 尤其难读
- 证据：
  - 任意字号共 195 处，其中 `text-[10px]` 109、`text-[11px]` 68、`text-[9px]` 11、`text-[8px]` 2。
  - 例子：`SceneGraph.tsx:370`（8px）、`SceneGraph.tsx:300、366`（9px）、`ScriptCommandStream.tsx:71、88、238、305、717`（9px）、`AiAssistantPanel.tsx:166、181`（10px）。
  - ProjectHome.css 还有 10 / 10.5 / 11px：`ProjectHome.css:116、173、463、727、823`。
- 问题：中文字形在 10px 以下笔画会糊。设计系统的最小正文档是 `--ol-font-size-2xs` 10px（只用于数字或标签）。
- 修复：
  - 正文最小用 12px（`--ol-font-size-sm`）。
  - 标签和徽标用 11px（`--ol-font-size-xs`）；10px 只给纯数字或拉丁缩写。
  - 删除 8/9/10.5px。
  - 在 `@theme` 中注册 `--text-2xs`/`--text-xs` 等，替换 `text-[Npx]`。

### M3 中文圆体只有 Regular 一个字重，却声明 `font-weight: 100 900`，导致中文粗体失效
- 证据：`fonts.css:9、20` 两个 `@font-face` 都只指向 `ResourceHanRoundedCN-Regular` 一个文件，却在 `fonts.css:10、21` 声明 `font-weight: 100 900`。浏览器会认为这个字体已经覆盖所有字重，于是**不再合成粗体**。
- 后果：标题、`font-semibold`、`.ph-root` 默认的 `font-weight: 600`（`ProjectHome.css` `.ph-root`）在中文上都显示为 Regular，拉丁字母（Quicksand/Fredoka）却是粗的，层级感丢失（需目测）。
- 修复：改为 `font-weight: 400`（允许合成粗体），或者补齐 Medium/Bold 字重文件，再把 `--ol-font-weight-*` 映射到真实存在的字重。

### M4 点击区域偏小
- 证据：
  - `h-6 w-6`（24px）9 处、`h-5 w-5` 7 处、`size-6` 7 处、`size-5` 3 处，还有 `h-4 w-4` 的按钮（`ScriptCommandStream.tsx:71`，16px，并且平时 `opacity-0`，只在 hover 时出现）。
  - 例子：`SceneManagerPanel.tsx:73`、`WorkflowPlanCard.tsx:109`、`SceneWorldline.tsx:324`、`AiUploadsPanel.tsx:83`、`AiAssistantPanel.tsx:239、495`（h-6 胶囊）。
- 修复：
  - 图标按钮最小 28px（`--ol-control-height-sm` 30px 更好），视觉图标保持 14–16px（`--ol-icon-sm/md`）。
  - 只在 hover 时出现的控件，在键盘聚焦时（`group-focus-within:opacity-100`）也要显示。

### M5 z-index 档位零散，弹窗层级互相冲突
- 证据：
  - 使用了 z-10/20/30/40/50/[60]/[70]/[100]/[9999]。
  - 手写弹窗用 z-50 / z-[60] / z-[70]（见 H2）。
  - Radix 的 Dialog/AlertDialog/Popover/Dropdown 都是 z-50（`ui/dialog.tsx:41、60`；`ui/alert-dialog.tsx:39、57`；`ui/popover.tsx:33`；`ui/dropdown-menu.tsx:45、233`）。
  - toast 是 `z-[9999]`（`StoryEditor.tsx:1221`）。
- 风险：在 z-[60]/[70] 弹窗内部打开的 Radix 浮层会被盖住（需目测具体路径）。
- 修复：统一用 `--ol-z-*` 档位（tokens.css：sheet 30 / chrome 50 / modal 60 / modal-nested 70 / drag-capture 100 / toast 110），在 `@theme` 注册为 `z-modal` 等工具类，ui 浮层随宿主层级提升。

### M6 只有一个手写 toast：颜色硬编码，对比度不足
- **状态：已修复**（`5decdc0`：新增 `lib/toast.ts` + `components/Toaster.tsx`，`aria-live` 通知区，颜色用 `--success` / `--destructive` / `--info`，层级用 `--ol-z-toast`，错误不自动消失）。
- 证据：`StoryEditor.tsx:1218-1225` 用 `style={{ background: 'rgba(34, 197, 94, 0.9)' }}` 配白字，对比 **2.13:1**；3 秒自动消失（`StoryEditor.tsx:878`）；用 `z-[9999]`。其他页面的成功/失败反馈靠 `alert` 或内联文字。
- 修复：做一个统一的 Toast/Banner 组件：
  - 颜色用 `--success-container` / `--success`（emerald-700，白底上约 5.3:1）以及 `--warning*`、`--info*`、`--destructive-container`。
  - 层级用 `--ol-z-toast`。
  - 保留 `role="status"`，错误用 `role="alert"`，且不自动消失。

### M7 没有动效降级
- 证据：
  - 代码中没有任何 `prefers-reduced-motion`、`motion-reduce` 或 `motion-safe`（`src` 下 grep 为 0；仅 design-system/tokens.css:609 有）。
  - `animate-spin` 46 处、`animate-in/out` 19 处，另有 `animate-float`、`animate-pulse-glow`（animations.css）。
  - tokens.css 末尾已有 reduced-motion 块，但它只把 `--ol-duration-*` 置 0，而组件目前还没有使用这些变量。
- 修复：
  - 在 animations.css 加 `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }`。
  - 装饰性的 float / pulse-glow 直接关闭。
  - 组件过渡改用 `--ol-duration-*`。

### M8 页面外框与导航不一致
- 证据：
  - 首页用自己的 `.ph-topbar` 岛式顶栏（`ProjectHome.tsx:726-853`）。
  - StoryEditor / AssetManager / ProjectMemoryPage 用 `OllaicTopBar`（`OllaicChrome.tsx`）。
  - `/flow/:projectId`（`routes.tsx:12`，FlowBoardPage）没有引用 OllaicChrome。
  - 返回方式各不相同：`ProjectMemoryPage.tsx:146` 是图标“返回编辑器”，`:155` 是文字“返回首页”；首页的品牌按钮 `ProjectHome.tsx:728` 是 `navigate('/')`（在首页上点等于什么都没发生）。
- 修复：统一 App Shell（顶栏高度 `--ol-topbar-height` 60px、`--ol-gutter`），所有二级页都用 OllaicTopBar 的面包屑和返回位置。FlowBoardPage 是否需要单独的外框，需你确认。

### M9 拉丁字体依赖 Google Fonts 在线加载
- 证据：`fonts.css:1` 用 `@import url('https://fonts.googleapis.com/...')`；`tauri.conf.json:26` 为 `"csp": null`。
- 后果：离线或网络受限时，Fredoka / Quicksand / Geist Mono 无法加载，回退到资源圆体或系统字体，桌面应用首屏字体会跳变（`display=swap`）。中文本身没有问题，资源圆体已经随包附带（`fonts.css:9`）。
- 修复：把三种字体以 woff2 形式放进 `src/assets/fonts`，在本地 `@font-face` 中只声明实际用到的 500/600/700（Geist Mono 400–700）。

---

## 低

### L1 `::selection` 浅色下几乎看不见文字
- 证据：`animations.css:45-48` 设置 `color: var(--card)`（浅色模式是白色），背景是 warm-glow 40%。白字在其上对比约 **1.35:1**。
- 修复：`background: color-mix(in srgb, var(--primary) 20%, transparent); color: inherit;`。

### L2 文案语言残留
- 证据：`ui/dialog.tsx:68` 的关闭按钮读屏文本是英文 `Close`，而界面语言是 `zh-CN`（`app-settings.ts:18`）。
- 修复：改成 `关闭`，或接入 i18n。

### L3 空状态的样式和层级不一致
- 证据：
  - 有的是大标题，如 `AssetManager.tsx:1401、1523、1648、1758`（`text-lg`）、`ScriptCommandStream.tsx:1164`（`text-base font-bold`）。
  - 有的只是 `text-xs` 灰字，如 `FlowStepInspector.tsx:695、705、819、850`、`AssetManager.tsx:2109、2843`。
  - 首页有完整的标题、说明和操作（`ProjectHome.tsx:975-982`）。
- 修复：做一个 `EmptyState` 组件（图标 `--ol-icon-xl`、标题 `--ol-font-size-base`、说明 `text-muted-foreground`、可选主操作），按“页面级”和“面板级”两种尺寸使用。

### L4 加载指示不统一
- 证据：`Loader2` + `animate-spin` 共 62 处，尺寸和颜色各写各的；没有骨架屏。
- 修复：做一个 `Spinner` 组件（size 用 `--ol-icon-*`，颜色 `currentColor`，带 `role="status"` 和 sr-only 文案），列表加载用 `--surface-container` 骨架。

### L5 输入框 placeholder 对比偏低
- 证据：`NewSceneDialog.tsx:100` 的 `placeholder:text-muted-foreground/60` 只有 2.66:1。
- 修复：placeholder 用 `--outline`（3.90:1）或不透明的 `--muted-foreground`。

---

## 已在 P0 修复（供对照）
- 暗色模式下 `--on-surface` 原为 #1d1b22，在暗色卡片 #1e1b26 上对比 **1.01:1**；`--on-surface-variant` #605a6b 在 #14111a 上 2.82:1。现在暗色分别是 #f2edf7 和 #b0a7c2（8.14:1）。
- ProjectHome 暗色下“危险”色原来仍是浅色模式的 #cf222e（3.16:1），容器是浅粉 #ffebe9。现在统一为暗色 `--destructive` #f47296（6.20:1）。
- 暗色下 `--tertiary*`、`--switch-background`、`--badge-soft-*`、`--chart-*`、`--shadow-*`、`--surface-dim` 原本都沿用浅色值，现在已有暗色值。

## 建议顺序
1. H1 焦点框（改一行 CSS，收益最大）
2. H6 主题单一来源
3. H4、H5 危险操作确认
4. H2 弹窗迁移到 Radix
5. H3 + L5 文字对比
6. M2、M3 字体与字号
7. M5、M6 层级与 toast
8. M7 动效降级
9. M1、M8 组件与外框统一

## 已修复（2026-11-02，分支 feat/scene-centric-workflow，未推送）
| 项 | 提交 | 改动 |
|---|---|---|
| H1 焦点框 | `c353c1c` | tokens.css 新增 `--focus-ring` / `--focus-ring-width` / `--focus-ring-offset`；删除 animations.css 未分层规则；theme.css 只保留一条 `:focus-visible`；ui 组件与业务组件去掉 `outline-none` / `ring-*` 焦点类；组合输入用 `.focus-ring-within`，脚本编辑区用 `.focus-ring-inset` |
| H4 永久移除确认 | `9296951`、`c6e2873` | 新增 `ConfirmDialog` 与 `useConfirmDialog`；ProjectHome 永久移除前确认 |
| H5 原生 alert/confirm | `5decdc0` | AssetManager、StoryEditor、VoiceDubbingPanel 的确认改用 AlertDialog，错误改用 toast |
| M6 toast | `5decdc0` | 共享 Toaster 替换 StoryEditor 的绿色 `z-[9999]` toast |
| H6 主题单一来源 | `a2c85e9` | 删除首页独立主题状态，开关调用 `saveAppTheme`；清除旧 `ollaic-home-theme` |

仍待处理：`useFlowRunController.ts` 中的 `window.confirm`，AssetManager / StoryEditor 重命名用的 `prompt()`。
