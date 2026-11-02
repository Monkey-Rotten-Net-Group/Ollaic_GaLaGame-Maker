# Ollaic 设计系统

> 适用范围：`apps/desktop`（Tauri 2 + React 18 + Vite 6 + Tailwind CSS 4.1 + shadcn/ui 风格的 Radix 组件）。
> 本目录由 2026-11-02 的代码审查生成，**所有数值均取自现有代码**；合并近似值时在 `tokens.json` 的 `$extensions.com.ollaic.replaces` 中记录了被替代的原始值。
> `tokens.css` / `tokens.json` **尚未被任何文件引用**，不会影响当前构建。接入步骤见文末「迁移计划」。

目录：

1. 设计原则
2. Token 架构
3. 颜色（primitive / semantic / light-dark / seed / 业务色）
4. 字体与字号
5. 间距与布局
6. 圆角
7. 阴影（Elevation）与模糊
8. 层级（z-index）
9. 动效
10. 断点与图标
11. 组件清单与使用规范
12. 审查结果：偏差清单（file:line → 应映射的 token）
13. 迁移计划（按优先级）
14. 未能确定的事项

---

## 1. 设计原则（从现有风格归纳）

| 原则 | 代码中的证据 |
|---|---|
| **柔和圆润的 GalGame 气质** | 字体栈以圆体为主：Fredoka（标题）+ Quicksand（正文）+ 资源圆体（中文）——`src/styles/theme.css:6-13`；基础圆角 `--radius: 0.85rem`（theme.css:70），胶囊形 `999px` 在 CSS 中出现 31 次。 |
| **轻盈的薰衣草底 + 大面积纯白卡片** | `--background #faf7fd`、`--card #ffffff`、`.story-shell` 用两团极淡的径向光晕 + 竖向渐变（theme.css:499-505）；ProjectHome.css 注释明确「Only accents & soft ambient glow change—cards stay white!」。 |
| **漂浮的“岛屿”式界面** | 顶栏是 3 个悬浮胶囊岛（`.ollaic-topbar-island`，theme.css:601-618），带 `backdrop-filter: blur(16px)` 和极淡双层阴影；主工作区是 26px 圆角的浮动卡片（theme.css:708-720）。 |
| **Material 3 式的色彩角色** | 使用 `surface-container-lowest…highest`、`on-primary-container`、`outline-variant`、`tertiary` 等 M3 角色，同时兼容 shadcn 的 `background/foreground/primary/muted/accent`。 |
| **可换主题色（Seed）** | 4 个 seed：violet（默认）/ crimson / teal / amber，通过 `html[data-seed]` 切换（theme.css:146-213、281-306；app-settings.ts:58）。 |
| **克制、带弹性的动效** | 统一的弹性曲线 `cubic-bezier(0.22, 1, 0.36, 1)`、140–240ms、按下缩放 0.96–0.98、悬停上浮 1px。 |
| **信息密度偏高的编辑器** | 主力字号是 12px（`text-xs` ×283）和 14px（`text-sm` ×203），大量 10–11px 的元数据；`font-mono` 使用 158 次（脚本/指令流）。 |

---

## 2. Token 架构

```
primitive（原始色板/数值，--ol-*）
   └─► semantic（语义角色，沿用 shadcn 与现有变量名：--background、--primary、--surface-container…）
          └─► component（组件级 scale：--ol-radius-*、--ol-shadow-*、--ol-z-*、--ol-duration-*…）
```

- **Primitive**：`--ol-{色系}-{级}`，例如 `--ol-violet-600`。只描述“是什么颜色”，组件代码中**不应直接使用**。
- **Semantic**：描述“用在哪”，名称与 `src/styles/theme.css` 现有变量完全一致，因此可直接替换；新增的只有 `primary-hover`、`destructive-container`、`on-destructive-container`、`ink-button*`、`success*`、`warning*`、`info*`、`scrim`、`preview-stage`。
- **模式**：亮色写在 `:root`，暗色写在 `.dark`（与 `@custom-variant dark (&:is(.dark *))` 一致）。Seed 写在 `:root:not(.dark)[data-seed=…]` 与 `:root.dark[data-seed=…]`。
- **Tailwind 接入**：接入时在 `@theme inline` 中把新增语义色映射为 `--color-*`（例如 `--color-success: var(--success)`），把 scale 映射为 `--radius-*`、`--shadow-*`、`--text-*`、`--breakpoint-*`，这样 `bg-success/10`、`rounded-2xl` 等类就会走 token。
- **JSON**：`tokens.json` 为 W3C Design Tokens（DTCG）格式，暗色值放在 `$extensions.com.ollaic.modes.dark`，来源行号放在 `$extensions.com.ollaic.source`。

统计：共 **462** 个 token（primitive 颜色 157、semantic 颜色 117、seed 覆盖 79、字体 27、间距 12、布局 7、圆角 9、阴影 11、层级 10、动效 15、模糊 4、断点 9、图标 5）。

---

## 3. 颜色

### 3.1 Primitive 色板

| Token (CSS) | 值 | 来源 | 合并替代的原始值 |
|---|---|---|---|
| `--ol-white` | `#ffffff` | theme.css:24 |  |
| `--ol-black` | `#000000` | 仅用于遮罩 scrim（bg-black/50 等） |  |
| `--ol-lavender-0` | `#ffffff` | theme.css:24,81,82 |  |
| `--ol-lavender-10` | `#fcfbfe` | theme.css:17 (--bg-top) | ProjectHome.css:5 --ph-bg-top #fcfbfe |
| `--ol-lavender-20` | `#faf7fd` | theme.css:22 (--background) |  |
| `--ol-lavender-30` | `#f7f4fa` | theme.css:83 (--surface-container-low) | ProjectHome.css:12 --ph-surface-low #f7f4fa |
| `--ol-lavender-40` | `#f5effb` | theme.css:18 (--bg-bottom) | ProjectHome.css:6 --ph-bg-bottom #f6effb |
| `--ol-lavender-50` | `#f4f0f9` | theme.css:47 (--muted), :76 (--sidebar-accent) |  |
| `--ol-lavender-60` | `#f1ecf7` | theme.css:84 (--surface-container) | ProjectHome.css:13 #f1ecf7 |
| `--ol-lavender-70` | `#efe8f8` | theme.css:36 (--secondary-container) |  |
| `--ol-lavender-80` | `#eae3f2` | theme.css:85 (--surface-container-high) | ProjectHome.css:14 #eae3f2 |
| `--ol-lavender-90` | `#e4deec` | theme.css:96 (--surface-dim) |  |
| `--ol-lavender-100` | `#e2d9ec` | theme.css:86 (--surface-container-highest) | theme.css:58 --switch-background #e2dce9 |
| `--ol-ink-500` | `#867d96` | theme.css:88 (--outline) | theme.css:272 dark --outline #857c96；ProjectHome.css:18 --ph-on-surface-muted #8c8499；ProjectHome.css:147 dark --ph-on-surface-muted #857c96 |
| `--ol-ink-600` | `#625b70` | theme.css:48 (--muted-foreground) | theme.css:95 --on-surface-variant #605a6b；ProjectHome.css:17 --ph-on-surface-variant #605a6b |
| `--ol-ink-700` | `#322d3a` | theme.css:980 (.ollaic-command-primary:hover) | ProjectHome.css:34 --ph-ink-btn-hover #322d3a |
| `--ol-ink-850` | `#1f1c24` | theme.css:968 (.ollaic-command-primary) | ProjectHome.css:33 --ph-ink-btn #1f1c24 |
| `--ol-ink-900` | `#1d1b22` | theme.css:23 (--foreground) | ProjectHome.css:16 --ph-on-surface #1d1b22 |
| `--ol-night-0` | `#121017` | theme.css:229 (dark --bg-top) |  |
| `--ol-night-10` | `#14111a` | theme.css:233 (dark --background) |  |
| `--ol-night-20` | `#191522` | theme.css:230 (dark --bg-bottom) |  |
| `--ol-night-30` | `#1e1b26` | theme.css:235 (dark --card/--popover/--sidebar/--surface-container-lowest) | ProjectHome.css:141 --ph-surface-solid #1e1b26 |
| `--ol-night-40` | `#24202e` | theme.css:268 (dark --surface-container-low) | theme.css:248 dark --muted #252130；theme.css:256 dark --input-background #252130；ProjectHome.css:142 --ph-surface-low #252130 |
| `--ol-night-50` | `#282433` | theme.css:266 (dark --surface-bright) |  |
| `--ol-night-60` | `#2b2637` | theme.css:269 (dark --surface-container) | theme.css:245 dark --secondary-container #2d283a；theme.css:250 dark --accent #2d283a；theme.css:262 dark --sidebar-accent #2d283a；ProjectHome.css:143 --ph-surface-container #2d283a |
| `--ol-night-70` | `#342e42` | theme.css:270 (dark --surface-container-high) | ProjectHome.css:144 --ph-surface-high #373146 |
| `--ol-night-80` | `#3e374f` | theme.css:271 (dark --surface-container-highest) |  |
| `--ol-night-text` | `#f2edf7` | theme.css:234 (dark --foreground) | ProjectHome.css:145 #f2edf7；theme.css:974 .dark .ollaic-command-primary #f2edf7 |
| `--ol-night-text-muted` | `#b0a7c2` | theme.css:249 (dark --muted-foreground) | ProjectHome.css:146 --ph-on-surface-variant #b8b0c7 |
| `--ol-violet-100` | `#eaddff` | theme.css:31 (--primary-container), :49 (--accent) |  |
| `--ol-violet-200` | `#c9b6fb` | ProjectHome.css:151 (dark --ph-primary-hover) |  |
| `--ol-violet-300` | `#b69df8` | theme.css:239 (dark --primary) |  |
| `--ol-violet-600` | `#65558f` | theme.css:29 (--primary) | AppSettingsDialog.tsx:73 '#65558f'；ProjectHome.css:408 .ph-seed-dot--violet |
| `--ol-violet-700` | `#53447a` | ProjectHome.css:24 (--ph-primary-hover) |  |
| `--ol-violet-850` | `#2b1f47` | theme.css:37 (--on-secondary-container) |  |
| `--ol-violet-900` | `#261454` | theme.css:240 (dark --primary-foreground) |  |
| `--ol-violet-950` | `#21005d` | theme.css:32 (--on-primary-container) |  |
| `--ol-violet-a14` | `rgba(101, 85, 143, 0.14)` | theme.css:55 (--border) | ScriptCommandStream.tsx:624 rgba(101,85,143,0.16) 回退值 |
| `--ol-violet-a18` | `rgba(101, 85, 143, 0.18)` | theme.css:89 (--outline-variant) | ProjectHome.css:19 --ph-outline rgba(101,85,143,0.2) |
| `--ol-violet-a11` | `rgba(101, 85, 143, 0.11)` | ProjectHome.css:20 (--ph-outline-variant) |  |
| `--ol-violet-a38` | `rgba(101, 85, 143, 0.38)` | theme.css:241 (dark --primary-container) | ProjectHome.css:153 rgba(101,85,143,0.4) |
| `--ol-violet-light-a15` | `rgba(208, 188, 255, 0.15)` | theme.css:254 (dark --border/--input) | ProjectHome.css:149 dark --ph-outline-variant rgba(208,188,255,0.12) |
| `--ol-violet-light-a18` | `rgba(208, 188, 255, 0.18)` | theme.css:273 (dark --outline-variant) | ProjectHome.css:148 dark --ph-outline rgba(208,188,255,0.22) |
| `--ol-rose-100` | `#f9d8e6` | theme.css:41 (--badge-soft-bg) | OllaicChrome.tsx:184 回退值 #f9d8e6；ProjectHome.css:29 --ph-badge-bg |
| `--ol-rose-800` | `#5c1936` | theme.css:42 (--badge-soft-text) | OllaicChrome.tsx:185 回退值 #5c1936；ProjectHome.css:30 --ph-badge-text |
| `--ol-rose-dark-bg` | `rgba(244, 114, 182, 0.2)` | ProjectHome.css:155 (dark --ph-badge-bg) |  |
| `--ol-rose-dark-text` | `#fbcfe8` | ProjectHome.css:156 (dark --ph-badge-text) |  |
| `--ol-crimson-bg-top` | `#fdfbfc` | theme.css:147 |  |
| `--ol-crimson-background` | `#fcf6f8` | theme.css:151 |  |
| `--ol-crimson-bg-bottom` | `#fbf0f4` | theme.css:148 |  |
| `--ol-crimson-surface-low` | `#faf3f5` | theme.css:161 |  |
| `--ol-crimson-surface` | `#f5e9ed` | theme.css:162 |  |
| `--ol-crimson-surface-high` | `#eedde3` | theme.css:163 |  |
| `--ol-crimson-surface-highest` | `#e6d0d8` | theme.css:164 |  |
| `--ol-crimson-100` | `#fce4eb` | theme.css:153,165 |  |
| `--ol-crimson-secondary-container` | `#f9e2e8` | theme.css:155 |  |
| `--ol-crimson-600` | `#9e2a47` | theme.css:152, :39 (--nav-active 全局固定) | AppSettingsDialog.tsx:74；ProjectHome.css:412 |
| `--ol-crimson-700` | `#822039` | ProjectHome.css:91 |  |
| `--ol-crimson-badge-text` | `#6e152d` | theme.css:166 |  |
| `--ol-crimson-900` | `#4a0e1f` | theme.css:154 |  |
| `--ol-crimson-on-secondary-container` | `#421220` | theme.css:156 |  |
| `--ol-crimson-dark-primary` | `#ffb1c5` | theme.css:282 |  |
| `--ol-crimson-dark-container` | `#552032` | theme.css:284 |  |
| `--ol-crimson-dark-on-container` | `#ffd9e2` | theme.css:285 |  |
| `--ol-crimson-a14` | `rgba(158, 42, 71, 0.14)` | theme.css:159 |  |
| `--ol-crimson-a18` | `rgba(158, 42, 71, 0.18)` | theme.css:160 | ProjectHome.css:88 rgba(158,42,71,0.18) |
| `--ol-crimson-glow` | `rgba(158, 42, 71, 0.1)` | theme.css:149 | ProjectHome.css:83 rgba(158,42,71,0.09) |
| `--ol-teal-bg-top` | `#fafdfe` | theme.css:170 |  |
| `--ol-teal-background` | `#f4f9fb` | theme.css:174 |  |
| `--ol-teal-bg-bottom` | `#eef7f9` | theme.css:171 |  |
| `--ol-teal-surface-low` | `#f1f7f8` | theme.css:184 |  |
| `--ol-teal-surface` | `#e8f1f3` | theme.css:185 |  |
| `--ol-teal-surface-high` | `#dde9ec` | theme.css:186 |  |
| `--ol-teal-surface-highest` | `#d0e1e5` | theme.css:187 |  |
| `--ol-teal-100` | `#d3f3f7` | theme.css:176, :92 (--tertiary-container) |  |
| `--ol-teal-secondary-container` | `#e0f3f6` | theme.css:178 |  |
| `--ol-teal-badge-bg` | `#d9f3f6` | theme.css:188 |  |
| `--ol-teal-600` | `#0f7685` | theme.css:175, :91 (--tertiary), :64 (--chart-2) | AppSettingsDialog.tsx:75；ProjectHome.css:416 |
| `--ol-teal-700` | `#0b5f6b` | ProjectHome.css:109 |  |
| `--ol-teal-badge-text` | `#084c57` | theme.css:189 |  |
| `--ol-teal-900` | `#06343b` | theme.css:177, :93 |  |
| `--ol-teal-on-secondary-container` | `#08373e` | theme.css:179 |  |
| `--ol-teal-dark-primary` | `#83d5e3` | theme.css:291 |  |
| `--ol-teal-dark-on-primary` | `#00363e` | theme.css:292 |  |
| `--ol-teal-dark-container` | `#004f59` | theme.css:293 |  |
| `--ol-teal-a14` | `rgba(13, 122, 138, 0.14)` | theme.css:182 |  |
| `--ol-teal-a18` | `rgba(13, 122, 138, 0.18)` | theme.css:183 |  |
| `--ol-teal-glow` | `rgba(13, 122, 138, 0.1)` | theme.css:172 |  |
| `--ol-amber-bg-top` | `#fefcf9` | theme.css:193 |  |
| `--ol-amber-background` | `#fbf7f0` | theme.css:197 |  |
| `--ol-amber-bg-bottom` | `#faf2e6` | theme.css:194 |  |
| `--ol-amber-surface-low` | `#faf5ee` | theme.css:207 |  |
| `--ol-amber-surface` | `#f4ece0` | theme.css:208 |  |
| `--ol-amber-surface-high` | `#ebe0d0` | theme.css:209 |  |
| `--ol-amber-surface-highest` | `#e0d2be` | theme.css:210 |  |
| `--ol-amber-100` | `#ffedd5` | theme.css:199 |  |
| `--ol-amber-secondary-container` | `#faebd7` | theme.css:201 |  |
| `--ol-amber-badge-bg` | `#fde8cd` | theme.css:211 |  |
| `--ol-amber-600` | `#8c5212` | theme.css:198 (--primary) |  |
| `--ol-amber-700` | `#70400c` | ProjectHome.css:127 |  |
| `--ol-amber-swatch` | `#b45309` | AppSettingsDialog.tsx:76；与 theme.css:195/205 的 rgba(180,83,9,…) 同色 | ProjectHome.css:420 .ph-seed-dot--amber #d97706；ProjectHome.css:874 color #d97706 |
| `--ol-amber-badge-text` | `#5c2c06` | theme.css:212 |  |
| `--ol-amber-900` | `#431407` | theme.css:200 |  |
| `--ol-amber-on-secondary-container` | `#3b1906` | theme.css:202 |  |
| `--ol-amber-dark-primary` | `#f5be7b` | theme.css:300 |  |
| `--ol-amber-dark-on-primary` | `#452807` | theme.css:301 |  |
| `--ol-amber-dark-container` | `#653d10` | theme.css:302 |  |
| `--ol-amber-a15` | `rgba(180, 83, 9, 0.15)` | theme.css:205 |  |
| `--ol-amber-a18` | `rgba(180, 83, 9, 0.18)` | theme.css:206 |  |
| `--ol-amber-glow` | `rgba(180, 83, 9, 0.09)` | theme.css:195 |  |
| `--ol-red-600` | `#cf222e` | theme.css:52 (--destructive), :66 (--chart-4) | ProjectHome.css:37 --ph-danger |
| `--ol-red-100` | `#ffebe9` | ProjectHome.css:38 (--ph-danger-container) |  |
| `--ol-red-900` | `#6e1119` | ProjectHome.css:39 |  |
| `--ol-red-dark` | `#f47296` | theme.css:252 (dark --destructive) |  |
| `--ol-red-dark-on` | `#3b0718` | theme.css:253 |  |
| `--ol-green-700` | `#006b56` | theme.css:65 (--chart-3) |  |
| `--ol-glow-lilac` | `rgba(168, 130, 235, 0.13)` | theme.css:19 | ProjectHome.css:7 rgba(168,130,235,0.12) |
| `--ol-glow-lilac-dark` | `rgba(168, 130, 235, 0.1)` | theme.css:231 |  |
| `--ol-glow-pink` | `rgba(244, 162, 194, 0.12)` | theme.css:20 |  |
| `--ol-glow-pink-dark` | `rgba(244, 114, 182, 0.07)` | theme.css:232 |  |
| `--ol-glow-sky` | `rgba(56, 189, 248, 0.08)` | theme.css:173 |  |
| `--ol-glow-orange` | `rgba(245, 158, 11, 0.07)` | theme.css:150 |  |
| `--ol-glow-pink-amber` | `rgba(244, 114, 182, 0.07)` | theme.css:196 |  |
| `--ol-status-emerald-300` | `oklch(84.5% 0.143 164.978)` | Tailwind emerald-300 |  |
| `--ol-status-emerald-400` | `oklch(76.5% 0.177 163.223)` | Tailwind emerald-400 | text-green-400 ×3 (AiMessageBubble.tsx:92) |
| `--ol-status-emerald-500` | `oklch(69.6% 0.17 162.48)` | Tailwind emerald-500 | rgba(34, 197, 94, 0.9) StoryEditor.tsx:1222；bg-green-400/10 PreviewNodeCard.tsx:21 |
| `--ol-status-emerald-700` | `oklch(50.8% 0.118 165.612)` | Tailwind emerald-700 | text-green-600 AiMessageBubble.tsx:93；text-emerald-600 FlowBoard.tsx:734 |
| `--ol-status-amber-300` | `oklch(87.9% 0.169 91.605)` | Tailwind amber-300 | text-yellow-400 MiniNodeCard.tsx:22 |
| `--ol-status-amber-500` | `oklch(76.9% 0.188 70.08)` | Tailwind amber-500 | text-yellow-500 AppSettingsDialog.tsx:583；bg-yellow-400/10 PreviewNodeCard.tsx:25 |
| `--ol-status-amber-700` | `oklch(55.5% 0.163 48.998)` | Tailwind amber-700 | text-amber-800 FlowBoard.tsx:455 |
| `--ol-status-blue-300` | `oklch(80.9% 0.105 251.813)` | Tailwind blue-300 (SnapshotManagerDialog.tsx:410) |  |
| `--ol-status-blue-500` | `oklch(62.3% 0.214 259.815)` | Tailwind blue-500 (FlowStepInspector.tsx:38) |  |

### 3.2 Semantic 颜色（Light / Dark 映射）

> 值已展开为最终颜色；`var(--x)` 表示引用另一个语义 token。“dark 原缺失”表示 `theme.css` 的 `.dark` 块没有覆盖该变量，暗色下会沿用亮色值（见偏差 D1）。

| Token | Light | Dark | 说明 |
|---|---|---|---|
| `--background` | `#faf7fd` | `#14111a` | theme.css:22/233 |
| `--foreground` | `#1d1b22` | `#f2edf7` | theme.css:23/234 |
| `--card` | `#ffffff` | `#1e1b26` | theme.css:24/235 |
| `--card-foreground` | `#1d1b22` | `#f2edf7` |  |
| `--popover` | `#ffffff` | `#1e1b26` |  |
| `--popover-foreground` | `#1d1b22` | `#f2edf7` |  |
| `--primary` | `#65558f` | `#b69df8` | theme.css:29/239 |
| `--primary-foreground` | `#ffffff` | `#261454` |  |
| `--primary-hover` | `#53447a` | `#c9b6fb` | 新增：取自 ProjectHome.css:24/151 --ph-primary-hover |
| `--primary-container` | `#eaddff` | `rgba(101, 85, 143, 0.38)` |  |
| `--on-primary-container` | `#21005d` | `#eaddff` |  |
| `--secondary` | `var(--surface-container)` | `var(--surface-container)` | theme.css:34 var(--surface-container) |
| `--secondary-foreground` | `var(--foreground)` | `var(--foreground)` |  |
| `--secondary-container` | `#efe8f8` | `#2b2637` | dark 由 #2d283a 合并到 #2b2637 |
| `--on-secondary-container` | `#2b1f47` | `#eaddff` |  |
| `--tertiary` | `#0f7685` | `#83d5e3` | dark 原缺失；新值取自 dark teal seed theme.css:291 |
| `--tertiary-container` | `#d3f3f7` | `#004f59` | dark 原缺失；取自 theme.css:293 |
| `--on-tertiary-container` | `#06343b` | `#d3f3f7` | dark 原缺失；取自 theme.css:294 |
| `--muted` | `#f4f0f9` | `#24202e` | dark 由 #252130 合并 |
| `--muted-foreground` | `#625b70` | `#b0a7c2` |  |
| `--accent` | `#eaddff` | `#2b2637` |  |
| `--accent-foreground` | `#21005d` | `#f2edf7` |  |
| `--destructive` | `#cf222e` | `#f47296` |  |
| `--destructive-foreground` | `#ffffff` | `#3b0718` |  |
| `--destructive-container` | `#ffebe9` | `color-mix(in srgb, #f47296 15%, transparent)` | 新增：light 取自 ProjectHome.css:38；dark 无来源，按 bg-destructive/10~/20 用法推导（待确认） |
| `--on-destructive-container` | `#6e1119` | `#f47296` | 新增：light 取自 ProjectHome.css:39 |
| `--border` | `rgba(101, 85, 143, 0.14)` | `rgba(208, 188, 255, 0.15)` |  |
| `--input` | `transparent` | `rgba(208, 188, 255, 0.15)` | theme.css:56/255 |
| `--input-background` | `#ffffff` | `#24202e` |  |
| `--switch-background` | `#e2d9ec` | `#3e374f` | dark 原缺失；light 由 #e2dce9 合并 |
| `--ring` | `#65558f` | `#b69df8` |  |
| `--outline` | `#867d96` | `#867d96` | dark #857c96 合并到 #867d96 |
| `--outline-variant` | `rgba(101, 85, 143, 0.18)` | `rgba(208, 188, 255, 0.18)` |  |
| `--surface-bright` | `#ffffff` | `#282433` |  |
| `--surface-dim` | `#e4deec` | `#191522` | dark 原缺失；取 dark --bg-bottom（待确认） |
| `--surface-container-lowest` | `#ffffff` | `#1e1b26` |  |
| `--surface-container-low` | `#f7f4fa` | `#24202e` |  |
| `--surface-container` | `#f1ecf7` | `#2b2637` |  |
| `--surface-container-high` | `#eae3f2` | `#342e42` |  |
| `--surface-container-highest` | `#e2d9ec` | `#3e374f` |  |
| `--on-surface` | `#1d1b22` | `#f2edf7` | dark 原缺失 → 暗色下 37 处 text-on-surface* 显示为 #1d1b22 |
| `--on-surface-variant` | `#625b70` | `#b0a7c2` | dark 原缺失；light #605a6b 合并到 #625b70 |
| `--nav-active` | `#9e2a47` | `#9e2a47` | 所有 seed/模式固定为 #9e2a47 |
| `--nav-active-foreground` | `#ffffff` | `#ffffff` |  |
| `--badge-soft-bg` | `#f9d8e6` | `rgba(244, 114, 182, 0.2)` | dark 原缺失；取自 ProjectHome.css:155 |
| `--badge-soft-text` | `#5c1936` | `#fbcfe8` | dark 原缺失；取自 ProjectHome.css:156 |
| `--ink-button` | `#1f1c24` | `#f2edf7` | 新增：.ollaic-command-primary / --ph-ink-btn |
| `--ink-button-hover` | `#322d3a` | `#ffffff` | 新增：theme.css:980 / ProjectHome.css:158 |
| `--ink-button-foreground` | `#ffffff` | `#1d1b22` |  |
| `--success` | `oklch(50.8% 0.118 165.612)` | `oklch(76.5% 0.177 163.223)` | 新增：text-emerald-700 ×7 / text-emerald-400 ×5 |
| `--success-solid` | `oklch(69.6% 0.17 162.48)` | `oklch(69.6% 0.17 162.48)` | 新增：bg-emerald-500 ×4 |
| `--success-container` | `color-mix(in srgb, oklch(69.6% 0.17 162.48) 10%, transparent)` | `color-mix(in srgb, oklch(69.6% 0.17 162.48) 10%, transparent)` | 新增：bg-emerald-500/10 ×9（/15 ×2 合并） |
| `--success-border` | `color-mix(in srgb, oklch(69.6% 0.17 162.48) 30%, transparent)` | `color-mix(in srgb, oklch(69.6% 0.17 162.48) 30%, transparent)` | 新增：border-emerald-500/30（/20、/25 合并） |
| `--warning` | `oklch(55.5% 0.163 48.998)` | `oklch(87.9% 0.169 91.605)` | 新增：text-amber-700 ×8 / text-amber-300 ×12 |
| `--warning-solid` | `oklch(76.9% 0.188 70.08)` | `oklch(76.9% 0.188 70.08)` | 新增：bg-amber-500 ×3 |
| `--warning-container` | `color-mix(in srgb, oklch(76.9% 0.188 70.08) 10%, transparent)` | `color-mix(in srgb, oklch(76.9% 0.188 70.08) 15%, transparent)` | 新增：bg-amber-500/10 ×4、/15 ×4 |
| `--warning-border` | `color-mix(in srgb, oklch(76.9% 0.188 70.08) 30%, transparent)` | `color-mix(in srgb, oklch(76.9% 0.188 70.08) 30%, transparent)` | 新增：border-amber-500/30（/25 合并） |
| `--info` | `#0f7685` | `oklch(80.9% 0.105 251.813)` | 新增：代码中无浅色 info 文本用例，light 暂复用 tertiary（待确认）；dark 取 text-blue-300 |
| `--info-solid` | `oklch(62.3% 0.214 259.815)` | `oklch(62.3% 0.214 259.815)` | 新增：bg-blue-500 ×3 |
| `--info-container` | `color-mix(in srgb, oklch(62.3% 0.214 259.815) 15%, transparent)` | `color-mix(in srgb, oklch(62.3% 0.214 259.815) 15%, transparent)` | 新增：bg-blue-500/15 |
| `--scrim` | `color-mix(in srgb, #000000 50%, transparent)` | `color-mix(in srgb, #000000 50%, transparent)` | 新增：bg-black/50 ×8，替代 /55 ×2、/60 |
| `--preview-stage` | `#0b0f19` | `#0b0f19` | 新增：RuntimePreviewPanel.tsx:360 bg-[#0b0f19]（游戏画布底色，两模式相同） |
| `--bg-top` | `#fcfbfe` | `#121017` |  |
| `--bg-bottom` | `#f5effb` | `#191522` |  |
| `--ph-glow-1` | `rgba(168, 130, 235, 0.13)` | `rgba(168, 130, 235, 0.1)` | 名称沿用 theme.css 的 --ph-glow-1 |
| `--ph-glow-2` | `rgba(244, 162, 194, 0.12)` | `rgba(244, 114, 182, 0.07)` |  |
| `--glass-topbar` | `rgba(255, 255, 255, 0.9)` | `rgba(30, 27, 38, 0.9)` | theme.css:135/274；ProjectHome --ph-surface dark rgba(28,25,36,0.9) 合并 |
| `--glass-panel` | `rgba(255, 255, 255, 0.94)` | `rgba(30, 27, 38, 0.92)` |  |
| `--glass-panel-muted` | `rgba(247, 244, 250, 0.88)` | `rgba(36, 32, 46, 0.88)` |  |
| `--glass-overlay` | `rgba(255, 255, 255, 0.95)` | `rgba(30, 27, 38, 0.95)` |  |
| `--glass-search` | `rgba(247, 244, 250, 0.95)` | `rgba(36, 32, 46, 0.95)` |  |
| `--scrollbar-thumb` | `color-mix(in srgb, var(--primary) 45%, transparent)` | `color-mix(in srgb, var(--primary) 45%, transparent)` |  |
| `--scrollbar-track` | `transparent` | `transparent` |  |
| `--grid-dot` | `color-mix(in srgb, var(--primary) 14%, transparent)` | `color-mix(in srgb, var(--primary) 14%, transparent)` |  |
| `--grid-line` | `color-mix(in srgb, var(--primary) 8%, transparent)` | `color-mix(in srgb, var(--primary) 8%, transparent)` |  |
| `--shadow-soft` | `rgba(29, 27, 34, 0.06)` | `rgba(0, 0, 0, 0.45)` | dark 原缺失；dark 值取自 ProjectHome.css:160 |
| `--shadow-faint` | `rgba(29, 27, 34, 0.03)` | `rgba(0, 0, 0, 0.25)` | dark 原缺失（dark 值待确认） |
| `--shadow-ink` | `rgba(29, 27, 34, 0.12)` | `rgba(0, 0, 0, 0.6)` | dark 原缺失；dark 值取自 ProjectHome.css:161 |
| `--chart-1` | `#65558f` | `#b69df8` |  |
| `--chart-2` | `#0f7685` | `#83d5e3` |  |
| `--chart-3` | `#006b56` | `oklch(76.5% 0.177 163.223)` | dark 原缺失（待确认） |
| `--chart-4` | `#cf222e` | `#f47296` |  |
| `--chart-5` | `#9e2a47` | `#ffb1c5` |  |
| `--sidebar` | `var(--card)` | `var(--card)` |  |
| `--sidebar-foreground` | `var(--foreground)` | `var(--foreground)` |  |
| `--sidebar-primary` | `var(--primary)` | `var(--primary)` |  |
| `--sidebar-primary-foreground` | `var(--primary-foreground)` | `var(--primary-foreground)` |  |
| `--sidebar-accent` | `var(--muted)` | `var(--accent)` |  |
| `--sidebar-accent-foreground` | `var(--foreground)` | `var(--foreground)` |  |
| `--sidebar-border` | `var(--border)` | `var(--border)` |  |
| `--sidebar-ring` | `var(--ring)` | `var(--ring)` |  |
| `--warm-glow` | `oklch(75% 0.08 75)` | `oklch(75% 0.08 75)` | theme.css:129；用于 ::selection、:focus-visible（animations.css）与 pulse-glow |

### 3.3 Seed 主题

| Token | violet（默认） | crimson | teal | amber |
|---|---|---|---|---|
| 色点 swatch | `#65558f` | `#9e2a47` | `#0f7685` | `#b45309` |
| `--bg-top` | `#fcfbfe` | `#fdfbfc` | `#fafdfe` | `#fefcf9` |
| `--bg-bottom` | `#f5effb` | `#fbf0f4` | `#eef7f9` | `#faf2e6` |
| `--ph-glow-1` | `rgba(168, 130, 235, 0.13)` | `rgba(158, 42, 71, 0.1)` | `rgba(13, 122, 138, 0.1)` | `rgba(180, 83, 9, 0.09)` |
| `--ph-glow-2` | `rgba(244, 162, 194, 0.12)` | `rgba(245, 158, 11, 0.07)` | `rgba(56, 189, 248, 0.08)` | `rgba(244, 114, 182, 0.07)` |
| `--background` | `#faf7fd` | `#fcf6f8` | `#f4f9fb` | `#fbf7f0` |
| `--primary` | `#65558f` | `#9e2a47` | `#0f7685` | `#8c5212` |
| `--primary-hover` | `#53447a` | `#822039` | `#0b5f6b` | `#70400c` |
| `--primary-container` | `#eaddff` | `#fce4eb` | `#d3f3f7` | `#ffedd5` |
| `--on-primary-container` | `#21005d` | `#4a0e1f` | `#06343b` | `#431407` |
| `--secondary-container` | `#efe8f8` | `#f9e2e8` | `#e0f3f6` | `#faebd7` |
| `--on-secondary-container` | `#2b1f47` | `#421220` | `#08373e` | `#3b1906` |
| `--ring` | `#65558f` | `#9e2a47` | `#0f7685` | `#8c5212` |
| `--border` | `rgba(101, 85, 143, 0.14)` | `rgba(158, 42, 71, 0.14)` | `rgba(13, 122, 138, 0.14)` | `rgba(180, 83, 9, 0.15)` |
| `--outline-variant` | `rgba(101, 85, 143, 0.18)` | `rgba(158, 42, 71, 0.18)` | `rgba(13, 122, 138, 0.18)` | `rgba(180, 83, 9, 0.18)` |
| `--surface-container-low` | `#f7f4fa` | `#faf3f5` | `#f1f7f8` | `#faf5ee` |
| `--surface-container` | `#f1ecf7` | `#f5e9ed` | `#e8f1f3` | `#f4ece0` |
| `--surface-container-high` | `#eae3f2` | `#eedde3` | `#dde9ec` | `#ebe0d0` |
| `--surface-container-highest` | `#e2d9ec` | `#e6d0d8` | `#d0e1e5` | `#e0d2be` |
| `--badge-soft-bg` | `#f9d8e6` | `#fce4eb` | `#d9f3f6` | `#fde8cd` |
| `--badge-soft-text` | `#5c1936` | `#6e152d` | `#084c57` | `#5c2c06` |

**暗色 seed 只覆盖 primary 系列（与 theme.css:281–306 一致）：**

| Token | violet | crimson | teal | amber |
|---|---|---|---|---|
| `--primary` | `#b69df8` | `#ffb1c5` | `#83d5e3` | `#f5be7b` |
| `--primary-foreground` | `#261454` | `#4a0e1f` | `#00363e` | `#452807` |
| `--primary-container` | `rgba(101, 85, 143, 0.38)` | `#552032` | `#004f59` | `#653d10` |
| `--on-primary-container` | `#eaddff` | `#ffd9e2` | `#d3f3f7` | `#ffedd5` |

### 3.4 业务色（指令类别 / 情绪 / 角色）

两种模式取值相同（theme.css 未在 `.dark` 中覆盖；目前看是有意为之，但暗色下的对比度未验证）。

| 组 | Token | 值 |
|---|---|---|
| category | `--color-story` | `oklch(62% 0.14 350)` |
| category | `--color-story-soft` | `oklch(62% 0.14 350 / 0.09)` |
| category | `--color-scene` | `oklch(64% 0.12 275)` |
| category | `--color-scene-soft` | `oklch(64% 0.12 275 / 0.09)` |
| category | `--color-audio` | `oklch(66% 0.11 210)` |
| category | `--color-audio-soft` | `oklch(66% 0.11 210 / 0.09)` |
| category | `--color-control` | `oklch(72% 0.12 75)` |
| category | `--color-control-soft` | `oklch(72% 0.12 75 / 0.09)` |
| category | `--color-effects` | `oklch(62% 0.14 25)` |
| category | `--color-effects-soft` | `oklch(62% 0.14 25 / 0.09)` |
| emotion | `--color-emotion-happy` | `oklch(78% 0.1 65)` |
| emotion | `--color-emotion-sad` | `oklch(72% 0.1 235)` |
| emotion | `--color-emotion-angry` | `oklch(65% 0.18 25)` |
| emotion | `--color-emotion-surprised` | `oklch(72% 0.13 305)` |
| emotion | `--color-emotion-shy` | `oklch(78% 0.1 0)` |
| emotion | `--color-emotion-serious` | `oklch(72% 0.1 165)` |
| emotion | `--color-emotion-default` | `oklch(70% 0.02 250)` |
| character | `--color-character-1` | `oklch(78% 0.1 65)` |
| character | `--color-character-2` | `oklch(72% 0.1 50)` |
| character | `--color-character-3` | `oklch(72% 0.06 165)` |
| character | `--color-character-4` | `oklch(72% 0.1 235)` |
| character | `--color-character-5` | `oklch(70% 0.12 305)` |
| character | `--color-character-6` | `oklch(80% 0.14 90)` |
| character | `--color-character-7` | `oklch(75% 0.13 0)` |
| character | `--color-character-8` | `oklch(75% 0.1 160)` |

**使用规范**

- 指令类别色用于 ScriptCommandStream / SceneGraph 的指令标签，配套的 `*-soft`（9% 透明）只做底色。
- 角色色用于头像与台词标签；`ScriptCommandStream.tsx:622` 用 `${charColor}20` 拼接 hex alpha，遇到 oklch 值会失效，应改为 `color-mix(in srgb, var(--color-character-N) 12%, transparent)`。
- 状态（成功 / 警告 / 信息 / 错误）**必须**用 `success / warning / info / destructive` 语义 token，不再直接写 `emerald-* / amber-* / green-* / yellow-* / red-* / blue-*`。

---

## 4. 字体与字号

### 4.1 字体族

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--font-display` | `Fredoka, 资源圆体, Resource Han Rounded CN, Resource-Han-Rounded-CN-Regular, Yuanti SC, STYuanti-SC-Bold, Hiragino Maru Gothic ProN, YouYuan, PingFang SC, ui-sans-serif, system-ui, sans-serif` | theme.css:6；替代：ProjectHome.css:50 --ph-font-display |
| `--font-body` | `Quicksand, 资源圆体, Resource Han Rounded CN, Resource-Han-Rounded-CN-Regular, Yuanti SC, STYuanti-SC-Regular, Hiragino Maru Gothic ProN, YouYuan, PingFang SC, Microsoft YaHei, ui-sans-serif, system-ui, sans-serif` | theme.css:10；替代：ProjectHome.css:46 --ph-font-sans |
| `--font-mono` | `Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace` | theme.css:14 |

`fonts.css:1` 从 Google Fonts 加载 `Fredoka:wght@500;600;700`、`Quicksand:wght@500;600;700`、`Geist Mono:wght@400;500;600;700`。

### 4.2 字号（Type scale）

当前 TSX 中 Tailwind 字号：`text-xs` 283、`text-sm` 203、`text-base` 14、`text-lg` 12、`text-xl` 4；任意值字号 `text-[10px]` 109、`text-[11px]` 68、`text-[9px]` 11、`text-[10.5px]` 3、`text-[8px]` 2、`text-[13px]` 1、`text-[15px]` 1、`text-[0.92em]` 1。CSS 中另有 13 个不同 px 字号（10、10.5、11、11.5、12、12.5、13、14.5、16、16.5、17、26px）。收敛为 9 级：

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-font-size-2xs` | `10px` | 徽标/元数据/计数；替代：text-[10px] ×109；text-[9px] ×11；text-[8px] ×2；text-[10.5px] ×3；CSS 10px ×2, 10.5px ×2 |
| `--ol-font-size-xs` | `11px` | 次要标签；替代：text-[11px] ×68；CSS 11px, 11.5px |
| `--ol-font-size-sm` | `12px` | 默认 UI 文本（text-xs）；替代：text-xs ×283；CSS 12px ×10；CSS 12.5px ×5 |
| `--ol-font-size-md` | `13px` | 替代：text-[13px] ×1；CSS 13px ×2 |
| `--ol-font-size-base` | `14px` | 正文（text-sm）；替代：text-sm ×203；CSS 14.5px ×2；text-[15px] ×1 |
| `--ol-font-size-lg` | `16px` | 替代：text-base ×14；CSS 16px ×2；16.5px；17px |
| `--ol-font-size-xl` | `18px` | 替代：text-lg ×12 |
| `--ol-font-size-2xl` | `20px` | 替代：text-xl ×4 |
| `--ol-font-size-display` | `26px` | ProjectHome.css:524 |

| 角色 | 字号 | 字重 | 行高 | 字族 |
|---|---|---|---|---|
| 页面标题（首页 hero） | display 26px | heading 700 | tight 1.25 | display |
| 区块标题 h1–h4 | xl 18px / lg 16px | heading 700 | heading 1.35 | display |
| 面板标题 `.ollaic-panel-header` | sm 12px（原 12.5px） | heading 700（原 800） | — | display，tracking caps 0.04em |
| 正文 | base 14px | normal / medium | normal 1.5 | body |
| 控件 / 按钮 | sm 12px | semibold 600 / bold 700 | normal 1.5 | body |
| 元数据 / 徽标 / 计数 | 2xs 10px | semibold–bold | none–tight | body，大写时 tracking overline 0.1em |
| 代码 / 指令 | sm 12px | normal | normal | mono |

### 4.3 字重

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-font-weight-normal` | `400` | 注意：fonts.css 只加载 Quicksand/Fredoka 500–700，400 实际未加载；theme.css:60 |
| `--ol-font-weight-medium` | `500` | theme.css:59; font-medium ×63 |
| `--ol-font-weight-semibold` | `600` | font-semibold ×84; CSS 600 ×9 |
| `--ol-font-weight-bold` | `700` | font-bold ×31; CSS 700 ×9 |
| `--ol-font-weight-heading` | `700` | 标题字重；替代：theme.css:448 h1–h4 800；theme.css:1004 800；ProjectHome.css 800 ×9；font-extrabold ×2 |

### 4.4 行高与字距

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-leading-none` | `1` | leading-none ×3 |
| `--ol-leading-tight` | `1.25` | 替代：ProjectHome.css line-height 1.2；leading-tight ×2 |
| `--ol-leading-heading` | `1.35` | theme.css:449 |
| `--ol-leading-normal` | `1.5` | theme.css:456；替代：ProjectHome.css 1.45, 1.55 |
| `--ol-leading-relaxed` | `1.625` | leading-relaxed ×12 |

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-tracking-tight` | `-0.025em` | tracking-tight ×1 |
| `--ol-tracking-body` | `0.01em` | theme.css:406; ProjectHome.css:68 |
| `--ol-tracking-label` | `0.02em` | theme.css:637；替代：tracking-wide 0.025em ×27 |
| `--ol-tracking-caps` | `0.04em` | theme.css:1005；替代：tracking-wider 0.05em ×4 |
| `--ol-tracking-overline` | `0.1em` | tracking-widest ×23 |

---

## 5. 间距与布局

Tailwind 4 的 `--spacing: 0.25rem`（4px）是基础单位。TSX 中最常用：`gap-2` 200、`px-3` 144、`py-2` 141、`px-2` 81、`gap-1` 71、`px-4` 68。CSS 中出现了不在 4px 网格上的 5、9、11、13、14、18px。

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-space-0` | `0px` |  |
| `--ol-space-0-5` | `2px` | gap-0.5 / p-0.5 / CSS 2px |
| `--ol-space-1` | `4px` | gap-1 ×71 |
| `--ol-space-1-5` | `6px` | gap-1.5 ×45；替代 CSS 5px ×4 |
| `--ol-space-2` | `8px` | gap-2 ×200；替代 CSS 9px |
| `--ol-space-2-5` | `10px` | px-2.5 ×23；替代 CSS 11px |
| `--ol-space-3` | `12px` | px-3 ×144；替代 CSS 13px、14px |
| `--ol-space-4` | `16px` | p-4 ×50 |
| `--ol-space-5` | `20px` | px-5 ×18；替代 CSS 18px |
| `--ol-space-6` | `24px` | p-6 ×9 |
| `--ol-space-7` | `28px` | ProjectHome.css:172 |
| `--ol-space-8` | `32px` | p-8 ×3 |

布局常量：

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-gutter` | `18px` | theme.css:527,709 topbar/workspace 外边距 |
| `--ol-topbar-height` | `60px` | theme.css:521 |
| `--ol-workspace-top` | `66px` | theme.css:711 |
| `--ol-island-height` | `42px` | theme.css:607 |
| `--ol-control-height-sm` | `30px` | theme.css:675,935；ProjectHome.css:307 |
| `--ol-control-height` | `34px` | theme.css:575；ProjectHome.css:353,380 |
| `--ol-agent-dock-width` | `376px` | theme.css:750 |

---

## 6. 圆角

**现状（编译后实际值）**：`theme.css:353-356` 只重写了 `sm/md/lg/xl`，其他档位仍是 Tailwind 默认值：

| 类 | 实际值 | 使用次数 |
|---|---|---|
| `rounded-xs` | 2px | 1 |
| `rounded` | **4px**（Tailwind 默认，不随 `--radius` 变化） | 136 |
| `rounded-sm` | 9.6px | 22 |
| `rounded-md` | 11.6px | 212 |
| `rounded-lg` | 13.6px | 51 |
| `rounded-xl` | 17.6px | 12 |
| `rounded-2xl` | **16px（比 xl 还小）** | 4 |
| `rounded-3xl` | 24px | 2 |
| `rounded-full` | 9999px | 72 |

**规范 scale：**

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-radius-xs` | `4px` | 细小标签/kbd；替代：rounded ×136 (Tailwind 默认 0.25rem)；rounded-xs ×1 |
| `--ol-radius-sm` | `calc(var(--radius) - 4px)` | = 9.6px；rounded-sm ×22；替代：ProjectHome.css:1079 8px |
| `--ol-radius-md` | `calc(var(--radius) - 2px)` | = 11.6px，控件默认；rounded-md ×212；替代：ProjectHome.css:1051 12px |
| `--ol-radius-lg` | `var(--radius)` | = 13.6px（--radius: 0.85rem）；theme.css:70; rounded-lg ×51；替代：ProjectHome.css:696 14px; theme.css:846 14px |
| `--ol-radius-xl` | `calc(var(--radius) + 4px)` | = 17.6px；rounded-xl ×12；替代：rounded-2xl ×4 (16px，比 xl 还小)；ProjectHome.css:796 16px |
| `--ol-radius-2xl` | `20px` | 面板/浮窗；theme.css:831,926; ProjectHome.css:478；替代：ProjectHome.css:746 22px |
| `--ol-radius-3xl` | `24px` | 对话框/大卡片；ProjectHome.css:955,1028; rounded-3xl ×2 |
| `--ol-radius-shell` | `26px` | 主工作区外壳；theme.css:714; ProjectHome.css:464 |
| `--ol-radius-full` | `999px` | CSS 999px ×31; rounded-full ×72 |

使用规范：控件（按钮、输入框、下拉）`md`；卡片 `lg`/`xl`；浮动面板 `2xl`；对话框 `3xl`；主工作区外壳 `shell`；胶囊按钮/标签/顶栏岛 `full`。

---

## 7. 阴影（Elevation）与模糊

阴影统一使用墨色 `rgb(29, 27, 34)` 而不是纯黑；Tailwind 默认的 `shadow-sm/md/lg/xl/2xl`（共 41 处）是纯黑阴影，与此不一致。

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-shadow-xs` | `0 2px 8px -2px rgba(29, 27, 34, 0.04)` | ScriptCommandStream.tsx:570；替代：shadow-xs ×2；shadow-sm ×16 (Tailwind 默认黑色阴影) |
| `--ol-shadow-island` | `0 4px 20px -4px rgba(29, 27, 34, 0.06), 0 1px 4px 0 rgba(29, 27, 34, 0.03)` | theme.css:613；替代：ProjectHome.css:41 (第二层 0.04)；dark: `0 8px 24px -4px rgba(0, 0, 0, 0.45)` |
| `--ol-shadow-panel` | `0 8px 24px -6px var(--shadow-soft)` | theme.css:928；替代：shadow-md ×4；shadow-lg ×9 |
| `--ol-shadow-card` | `0 10px 28px -8px rgba(29, 27, 34, 0.08), 0 2px 6px -1px rgba(29, 27, 34, 0.04)` | ProjectHome.css:43；dark: `0 12px 30px -8px rgba(0, 0, 0, 0.45)` |
| `--ol-shadow-hero` | `0 20px 50px -16px rgba(29, 27, 34, 0.09), 0 4px 14px -2px rgba(29, 27, 34, 0.04)` | theme.css:717；替代：ProjectHome.css:42 (0.1 / 0.05)；dark: `0 24px 56px -14px rgba(0, 0, 0, 0.6)` |
| `--ol-shadow-floating` | `0 20px 48px rgba(29, 27, 34, 0.22)` | theme.css:832；替代：shadow-xl ×1；shadow-2xl ×11 |
| `--ol-shadow-button` | `0 4px 12px rgba(29, 27, 34, 0.14)` | theme.css:970；替代：ProjectHome.css:595 0 6px 16px rgba(29,27,34,0.16) |
| `--ol-shadow-sheet` | `-8px 0 24px var(--shadow-soft)` | SceneManagerPanel.tsx:65；替代：FlowBoard.tsx:872 -10px 0 30px；AssetManager.tsx:1983 -4px 0 24px faint；theme.css:860 -12px 0 32px |
| `--ol-shadow-halo` | `0 0 0 3px color-mix(in srgb, var(--primary) 14%, transparent)` | theme.css:1009；替代：theme.css:989 16% |
| `--ol-shadow-tab-active` | `0 4px 12px -2px color-mix(in srgb, var(--primary) 38%, transparent)` | theme.css:1016 |
| `--ol-shadow-glow` | `0 0 20px color-mix(in srgb, var(--color-warm-glow) 60%, transparent)` | AssetManager.tsx:1483 ×3 |

| 层级 | Token | 典型组件 |
|---|---|---|
| 0 | 无 | 内嵌列表、工具栏 |
| 1 | `xs` | 指令卡片、列表项 |
| 2 | `island` / `panel` | 顶栏岛、`.ollaic-panel`、Popover |
| 3 | `card` | 首页项目卡 |
| 4 | `hero` | 主工作区、首页 hero |
| 5 | `floating` | 浮动预览窗、对话框 |
| 侧滑 | `sheet` | SceneManagerPanel、FlowBoard 检查器、Agent dock |

模糊：

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-blur-overlay` | `4px` | backdrop-blur-xs |
| `--ol-blur-sm` | `8px` | backdrop-blur-sm ×7；替代 ProjectHome 6px/8px/10px |
| `--ol-blur-glass` | `12px` | theme.css:929 .ollaic-panel |
| `--ol-blur-glass-strong` | `16px` | theme.css:616；ProjectHome.css ×4 |

---

## 8. 层级（z-index）

现状共 13 个不同值：0、2、4、10、20、30、35、40、50、60、70、100、9999。自制弹窗分别用了 z-50、z-[60]、z-[70]，与固定顶栏（z-50）和 Radix 浮层（z-50）同层。

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-z-base` | `0` | ProjectHome.css z 0/2/4 局部 |
| `--ol-z-raised` | `10` | z-10 ×10 |
| `--ol-z-sticky` | `20` | z-20 |
| `--ol-z-sheet` | `30` | z-30 FlowBoard.tsx:872；theme.css:858 35 合并 |
| `--ol-z-popover-catcher` | `40` | z-40 SceneWorldline.tsx:184 |
| `--ol-z-chrome` | `50` | theme.css:519 topbar; Radix 浮层 z-50 |
| `--ol-z-modal` | `60` | z-[60] AiSettingsDialog.tsx:266；替代自制弹窗 z-50 |
| `--ol-z-modal-nested` | `70` | z-[70] ProjectMetadataDialog.tsx:99, SnapshotManagerDialog.tsx:108 |
| `--ol-z-drag-capture` | `100` | z-[100] StoryEditor.tsx:1285, RuntimePreviewPanel.tsx:221 |
| `--ol-z-toast` | `110` | 替代 z-[9999] StoryEditor.tsx:1221 |

---

## 9. 动效

现状：CSS 中的时长有 140/150/160/180/200/240ms、0.5s，Tailwind `duration-150/200/300`；曲线有 `cubic-bezier(0.22, 1, 0.36, 1)`、`ease`、`ease-out`、Tailwind 默认曲线。关键帧：`fadeIn`、`pulse-glow`、`float`（animations.css）、`phSpin`（ProjectHome.css:719），以及 `tw-animate-css` 的 `animate-in/out`（Radix 弹层）。无动画库（未发现 framer-motion / motion / react-spring）。**全仓库没有任何 `prefers-reduced-motion` 处理。**

时长：

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-duration-press` | `140ms` | theme.css:468 |
| `--ol-duration-fast` | `160ms` | theme.css:467,682；替代 150ms ×3、0.15s、duration-150 ×4 |
| `--ol-duration-base` | `180ms` | theme.css:463,638,947；替代 0.18s ×3 |
| `--ol-duration-moderate` | `240ms` | ProjectHome.css:755；替代 0.2s ×2、duration-200 ×3 |
| `--ol-duration-slow` | `300ms` | duration-300 ×1 |
| `--ol-duration-enter` | `500ms` | animations.css:31 fadeIn 0.5s |

曲线：

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-ease-spring` | `0.22, 1, 0.36, 1` | theme.css:463；ProjectHome.css:55 --ph-ease-spring |
| `--ol-ease-standard` | `0.25, 0.1, 0.25, 1` | 即 CSS `ease`（CSS 中最常用） |
| `--ol-ease-tailwind` | `0.4, 0, 0.2, 1` | Tailwind 默认 transition 曲线 / ease-in-out |
| `--ol-ease-out` | `0, 0, 0.2, 1` | Tailwind ease-out |

交互反馈：

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-scale-press` | `0.97` | 替代 theme.css:477 的 0.98、:650 的 0.96、:957 的 0.97 |
| `--ol-lift-hover` | `-1px` | theme.css:953、ProjectHome.css:373 的 `translateY(-1px)` |

循环动画：

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-loop-spin` | `1s` | ProjectHome.css phSpin / animate-spin |
| `--ol-loop-pulse-glow` | `2s` | animations.css:35 |
| `--ol-loop-float` | `6s` | animations.css:39 |

使用规范：颜色/边框过渡用 `fast` + `standard`；按钮按下 / 卡片悬停用 `base` + `spring`；面板进出场用 `moderate` + `spring`；只做 `transition-colors` 时不要用 `transition-all`（目前 `transition-all` 43 处）。`tokens.css` 末尾附带了 `prefers-reduced-motion` 降级。

---

## 10. 断点与图标

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-breakpoint-sm` | `640px` | Tailwind sm；theme.css:871 max-width 639px |
| `--ol-breakpoint-md` | `768px` | Tailwind md |
| `--ol-breakpoint-lg` | `1024px` | Tailwind lg；theme.css:854 max-width 1023px |
| `--ol-breakpoint-topbar` | `1100px` | theme.css:559；min-[1100px] ×3 |
| `--ol-breakpoint-xl` | `1280px` | Tailwind xl |
| `--ol-breakpoint-wide` | `1440px` | min-[1440px] ×2 |
| `--ol-breakpoint-2xl` | `1536px` | Tailwind 2xl |
| `--ol-breakpoint-ultra` | `1800px` | min-[1800px] ×4 |
| `--ol-breakpoint-home-compact` | `920px` | 仅首页使用，建议并入 lg (1024px) 或 md；ProjectHome.css:1093 |

图标：只使用 `lucide-react@0.487.0`（36 个文件），未发现其他图标库。尺寸写法混用 `size={13}` 属性（31 处，值为 10/11/12/13/14）、`h-4 w-4`（71）与 `size-4`（56）。规范：

| Token | 值 | 来源 / 替代 |
|---|---|---|
| `--ol-icon-xs` | `12px` | h-3 w-3 ×38; size={12} ×7（替代 10/11px） |
| `--ol-icon-sm` | `14px` | h-3.5 w-3.5 ×69; size-3.5 ×23; size={14} ×7（替代 size={13} ×12） |
| `--ol-icon-md` | `16px` | h-4 w-4 ×71; size-4 ×56（Button 默认） |
| `--ol-icon-lg` | `20px` | h-5 w-5 ×7 |
| `--ol-icon-xl` | `24px` | size-6 ×7 |

统一用 Tailwind `size-*` 类，不再用 `size={n}` 属性；`size={13}` 归入 `sm` 14px。

---

## 11. 组件清单与使用规范

### 11.1 基础组件（`src/app/components/ui/`，shadcn 风格 + Radix）

| 组件 | 文件 | 变体 | 使用该组件的文件数 | 备注 |
|---|---|---|---|---|
| Button | `ui/button.tsx` | variant：default / destructive / outline / secondary / ghost / link；size：default(h-9) / sm(h-8) / lg(h-10) / icon(size-9) | 5（`<Button` 40 处） | 仓库中唯一的 `cva`；destructive 用了 `text-white`，应为 `text-destructive-foreground` |
| Dialog | `ui/dialog.tsx` | — | 5 | 遮罩 `bg-black/50`，关闭按钮 `rounded-xs` |
| AlertDialog | `ui/alert-dialog.tsx` | — | 1 | |
| DropdownMenu | `ui/dropdown-menu.tsx` | item variant：default / destructive；inset | 4 | |
| ContextMenu | `ui/context-menu.tsx` | 同上 | 1 | |
| Popover | `ui/popover.tsx` | — | 3 | `shadow-md`（纯黑阴影） |
| Tabs | `ui/tabs.tsx` | — | 1（`<Tabs` 10 处） | |
| Switch | `ui/switch.tsx` | — | 4 | 使用 `--switch-background`（暗色未定义） |
| Progress | `ui/progress.tsx` | — | 2 | |
| ScrollArea | `ui/scroll-area.tsx` | — | 1 | |
| Textarea | `ui/textarea.tsx` | — | 2 | |
| Input | `ui/input.tsx` | — | **0** | 未被使用；页面中有 72 个原生 `<input>` |

### 11.2 全局 CSS 组件类（`theme.css` @layer components）

| 类 | 使用次数 | 作用 | 对应 token |
|---|---|---|---|
| `.ollaic-icon-button` | 25 | 32px 圆形图标按钮 | radius-full、duration-base |
| `.ollaic-command` / `-primary` | 10 / 3 | 30px 胶囊命令按钮；primary 为墨色按钮 | control-height-sm、ink-button、shadow-button |
| `.ollaic-top-action` | 7 | 顶栏文字按钮 | ease-spring |
| `.ollaic-panel` / `-header` | 7 / 1 | 玻璃面板 + 44px 头部 | radius-2xl、glass-overlay、shadow-panel、blur-glass |
| `.ollaic-topbar*`、`.ollaic-view-tab/switch`、`.ollaic-top-search` | 各 1–4 | 顶栏三岛结构 | island-height、shadow-island、nav-active |
| `.ollaic-workspace` | 3 | 主工作区卡片 | radius-shell、shadow-hero、gutter |
| `.ollaic-blueprint` / `.ollaic-dot-grid` / `.flow-grid` | 3 / 1 / 1 | 画布网格背景 | grid-line、grid-dot |
| `.ollaic-hard-shadow` / `.ollaic-interactive` | 3 / 2 | 3px 主色光环 | shadow-halo |
| `.ollaic-layered-tab-active` | 1 | 激活态胶囊 tab | shadow-tab-active |
| `.ollaic-chamfer-tr` | 5 | 已退化为 `border-radius: 999px` 的旧切角类 | 建议删除，直接用 `rounded-full` |
| `.story-shell` | 2 | 环境光背景 | bg-top、bg-bottom、ph-glow-* |

### 11.3 首页专用组件（`ProjectHome.css`，`.ph-*`）

`.ph-root` 定义了一套**独立的 `--ph-*` token**（约 40 个变量 × 亮/暗/3 个 seed），与 theme.css 大量重复（见偏差 D2）。组件：`ph-topbar`、`ph-brand-island`、`ph-center-island`、`ph-filter-pill`、`ph-search-pill`、`ph-action-pill`、`ph-seed-island/dot`、hero、项目卡 `ph-card`、对话框等。

### 11.4 重复 / 近似重复的模式

| 模式 | 现状 | 建议 |
|---|---|---|
| 按钮 | 3 套并行实现：`ui/Button`（40 处）、`.ollaic-command`/`.ollaic-icon-button`/`.ollaic-top-action`、`.ph-action-pill`；另有 **285 个原生 `<button>`** 直接写 Tailwind | 把 `ollaic-command`、`icon-button`、`top-action`、`pill` 做成 Button 的 `variant`（`command`、`ink`、`pill`）和 `size`（`xs`=30px、`icon-sm`=32px），用 cva 统一 |
| 模态框 | 8 个自制遮罩（`fixed inset-0`）：AppSettingsDialog.tsx:372、AssetManager.tsx:2427、CharacterPanel.tsx:1673 / 1809、VoiceDubbingPanel.tsx:598、AiSettingsDialog.tsx:266、ProjectMetadataDialog.tsx:99、SnapshotManagerDialog.tsx:108、ScenePreviewDialog.tsx:87；遮罩透明度 50/55/60%，层级 z-50/60/70，模糊 none/xs/sm | 全部改用 `ui/Dialog`（自带焦点陷阱、Esc、动画），遮罩用 `--scrim`，层级用 `--ol-z-modal` |
| 输入框 | `ui/Input` 0 次使用；72 个原生 `<input>`、22 个 `<textarea>`（只有 2 处用 `ui/Textarea`）、21 个原生 `<select>` | 统一用 Input / Textarea；新增 Select 组件（可基于 Radix Select） |
| 状态标签 / Badge | 无 Badge 组件；状态色直接写 Tailwind 色板（190 处，98 种类名） | 新增 `Badge`（cva：`neutral / primary / success / warning / info / danger / soft`），字号 2xs、`rounded-full` |
| Toast | StoryEditor.tsx:1219-1222 自制 toast（`z-[9999]`、`rgba(34,197,94,0.9)`） | 新增 Toast 组件，背景 `--success-solid`，层级 `--ol-z-toast` |
| 右侧抽屉 | SceneManagerPanel.tsx:65、FlowBoard.tsx:872、AssetManager.tsx:1983、theme.css:860 四种侧影 | 新增 Sheet 组件（或基于 Dialog），阴影 `--ol-shadow-sheet` |

---

## 12. 审查结果：偏差清单

统计（不含测试文件，91 个 TS/TSX 源文件）：

| 项目 | 数量 |
|---|---|
| TSX 中硬编码 hex | 55 处 / 42 种（其中 36 种在 ProjectHome.tsx:117-227 的 SVG 封面插画中） |
| TSX 中硬编码 rgb/rgba | 3 处 |
| CSS 中 hex | theme.css 157 处 / 94 种；ProjectHome.css 80 处 / 67 种 |
| CSS 中 rgba | theme.css 43；ProjectHome.css 41 |
| Tailwind 原生色板类（绕过语义 token） | 190 处 / 98 种 |
| Tailwind 任意值 `[...]` | 434 处 / 92 种（其中尺寸/颜色/阴影/层级类约 260 处，其余为 `data-[state]` 等选择器） |
| 任意字号 `text-[…]` | 197 处 |
| 内联 `style={{…}}` | 43 处 |
| 使用语义颜色类 | 2084 处 / 189 种 |

### 高优先级

| # | 问题 | 位置 | 应映射到 |
|---|---|---|---|
| D1 | **暗色模式缺变量**：`:root` 定义 105 个变量、`.dark` 只覆盖 50 个；除字体、业务色等与模式无关的变量外，有 34 个没有暗色值，其中 18 个是随模式应变化的颜色。最严重的是 `--on-surface` (#1d1b22) 和 `--on-surface-variant` (#605a6b)：暗色下 37 处 `text-on-surface*` 是近黑文字配深色背景。还缺 `--tertiary*`、`--switch-background`、`--badge-soft-*`、`--surface-dim`、`--shadow-*`、`--chart-*` | theme.css:94-96、:228-279；用例如 SceneManagerPanel.tsx:67、:140，AiAssistantPanel.tsx:309，ui/switch.tsx:16 | `tokens.css` 的 `.dark` 已补全（标“待确认”的值需要视觉确认） |
| D2 | **第二套 token 系统 `--ph-*`**：ProjectHome.css:3-162 重复定义背景、表面、文字、主色、描边、阴影、字体，且数值有漂移：`--ph-bg-bottom #f6effb` vs `--bg-bottom #f5effb`；`--ph-outline` 0.2 vs `--outline-variant` 0.18；暗色表面 `#252130/#2d283a/#373146` vs `#24202e/#2b2637/#342e42`；暗色 `--ph-on-surface-variant #b8b0c7` vs `--muted-foreground #b0a7c2`。违反 `src/styles/AGENTS.md:5`「Avoid a second token system」 | ProjectHome.css:3-162 | 用 semantic token 替换全部 `--ph-*`（对照表见 tokens.json 中各 primitive 的 replaces） |
| D3 | **琥珀 seed 有 3 个不同颜色**：主题主色 `#8c5212`（theme.css:198），设置面板色点 `#b45309`（AppSettingsDialog.tsx:76），首页色点 `#d97706`（ProjectHome.css:420、:874）。四个色点在 TSX 和 CSS 里各写一遍 | AppSettingsDialog.tsx:73-76；ProjectHome.css:407-421 | `--seed-swatch-{violet,crimson,teal,amber}` |
| D4 | **没有状态色 token**：成功/警告/信息分别用 emerald+green、amber+yellow、blue+sky+purple，同一语义多种写法：例如 FlowStepInspector.tsx:503 `text-emerald-700`、AiMessageBubble.tsx:92-93 `text-green-400/600`、MiniNodeCard.tsx:22 `text-yellow-400`、AppSettingsDialog.tsx:581-583 `text-green-500`/`text-yellow-500`、PreviewNodeCard.tsx:21-25、AiPendingCard.tsx:21-23 `bg-green-950/40`、StoryEditor.tsx:1222 `rgba(34,197,94,0.9)` | 最集中：FlowStepInspector.tsx（12）、ScriptCommandStream.tsx（10）、PreviewNodeCard.tsx（8）、SceneCard.tsx（7）、FlowBoard.tsx（7） | `--success*`、`--warning*`、`--info*`、`--destructive*` |
| D5 | **圆角刻度倒挂且混用**：`rounded`=4px（136 处）不随 `--radius` 变化；`rounded-2xl`=16px 小于 `rounded-xl`=17.6px；CSS 里有 8/12/14/16/20/22/24/26px 共 8 种 | theme.css:353-356；rounded-2xl：ProjectMetadataDialog.tsx:100、ScenePreviewDialog.tsx:89；CSS：ProjectHome.css:696、746、796、1051、1079 | `--ol-radius-*`；接入时在 `@theme` 中把 `--radius-2xl: 20px`、`--radius-3xl: 24px` 写死，并把 `rounded` 改为 `rounded-xs` 或 `rounded-sm` |
| D6 | **字号不在刻度上**：197 处 `text-[…]`（`text-[10px]` 109，集中在 CharacterPanel.tsx 18、ScriptCommandStream.tsx 15、AssetManager.tsx 10；`text-[11px]` 68，集中在 WorkflowPlanCard.tsx 11、FlowStepInspector.tsx 9；`text-[9px]` 11、`text-[8px]` 2 —— SceneGraph.tsx:370、:378）；CSS 中 12.5/14.5/16.5px 等半像素字号 | 见左 | `--ol-font-size-2xs/xs/sm/…`，接入后用 `text-2xs`、`text-xs`（重定义为 11px 会改变 283 处，建议新增名字而不是改 `text-xs`） |
| D7 | **字重 800 与 400 没有加载**：`fonts.css:1` 只加载 Fredoka/Quicksand 500–700，但 h1–h4（theme.css:448）、`.ollaic-panel-header`（theme.css:1004）、ProjectHome.css 9 处、`font-extrabold`（OllaicChrome.tsx:178 等 2 处）用 800；body 用 400（theme.css:405）。浏览器会回退到最近字重或合成粗体，导致标题渲染不可控 | 见左 | `--ol-font-weight-heading: 700`；或在 fonts.css 增加 400 字重 |

### 中优先级

| # | 问题 | 位置 | 应映射到 |
|---|---|---|---|
| D8 | 自制模态框 8 个，遮罩/层级/模糊各不相同 | 见 11.4 | `ui/Dialog` + `--scrim` + `--ol-z-modal` |
| D9 | `z-[9999]` toast、`z-[100]` 拖拽遮罩、z-[60]/[70] 弹窗 | StoryEditor.tsx:1221、:1285；RuntimePreviewPanel.tsx:221；AiSettingsDialog.tsx:266；ProjectMetadataDialog.tsx:99；SnapshotManagerDialog.tsx:108 | `--ol-z-*` |
| D10 | 三种不同的焦点样式：animations.css:51-54 全局 `:focus-visible` 用 warm-glow 70%；theme.css:480-487 按钮/输入用 `ring` 与白色混合；shadcn 组件用 `ring-[3px] ring-ring/50` | 见左 | 统一用 `--ring`，宽度 2px、offset 2px |
| D11 | `::selection` 文字色为 `var(--card)`（亮色为白色）配 40% 暖光背景，亮色模式下对比度很低 | animations.css:45-48 | 文字色改为 `--foreground` |
| D12 | 阴影使用 Tailwind 默认纯黑（`shadow-sm` 16、`shadow-2xl` 11、`shadow-lg` 9、`shadow-md` 4 等），以及 5 种任意值阴影 | 如 AppSettingsDialog.tsx:373、ui/popover.tsx:33、SceneGraph.tsx:305 | `--ol-shadow-*` |
| D13 | 近似重复颜色：`--muted-foreground #625b70` ≈ `--on-surface-variant #605a6b`；`--switch-background #e2dce9` ≈ `--surface-container-highest #e2d9ec`；暗色 `--muted/--input-background #252130` ≈ `--surface-container-low #24202e`；暗色 `--accent/--secondary-container #2d283a` ≈ `--surface-container #2b2637` | theme.css:48/95、58/86、248/268、245/269 | 已在 primitive 层合并（见 3.1 replaces 列） |
| D14 | 组件内硬编码回退色，重复 token 值：`var(--badge-soft-bg, #f9d8e6)` | OllaicChrome.tsx:184-185；ScriptCommandStream.tsx:624 | 去掉回退值 |
| D15 | `${charColor}20` 字符串拼接 alpha | ScriptCommandStream.tsx:622 | `color-mix()` |
| D16 | 预览区底色 `bg-[#0b0f19]`，以及 `border-slate-600` | RuntimePreviewPanel.tsx:360、:389 | `--preview-stage` |
| D17 | 没有 `prefers-reduced-motion`；`animate-float`(6s)、`animate-pulse-glow`(2s) 无限循环 | animations.css:34-40；全仓库 | tokens.css 末尾的降级 + `motion-reduce:` 变体 |
| D18 | 交互按下缩放 0.96 / 0.97 / 0.98 三个值；过渡时长 140/150/160/180/200/240ms 并存 | theme.css:477、650、957；ProjectHome.css:436、755、865 | `--ol-scale-press`、`--ol-duration-*` |

### 低优先级

| # | 问题 | 位置 | 应映射到 |
|---|---|---|---|
| D19 | `default_shadcn_theme.css`（120 行）未被任何文件引用 | apps/desktop/default_shadcn_theme.css | 确认后删除 |
| D20 | `.ollaic-chamfer-tr` 已退化为 `border-radius: 999px`，仍有 5 处使用 | theme.css:508-511 | `rounded-full` |
| D21 | 非网格间距 5/9/11/13/14/18px | theme.css:527、629、631、938；ProjectHome.css:185、251、354 | `--ol-space-*` / `--ol-gutter` |
| D22 | 自定义断点 920/1100/1440/1800px 只在任意值或单个 CSS 中出现 | ProjectHome.css:1093；OllaicChrome.tsx:182、218、239 | `--ol-breakpoint-*`，写入 `@theme` 后可用 `topbar:`、`wide:`、`ultra:` |
| D23 | 图标尺寸 3 种写法（`size={n}` 31、`h-* w-*`、`size-*`） | 如 `size={13}` 12 处 | `--ol-icon-*` + `size-*` 类 |
| D24 | 首页 SVG 封面插画中的 36 种 hex | ProjectHome.tsx:117-227 | 属于插画内容，建议保留为插画常量，不纳入 token |
| D25 | 暗色 seed 只换主色，表面仍是紫调（亮色 seed 会换表面色） | theme.css:281-306 | 待设计决策 |
| D26 | `teal` seed 的描边色 `rgba(13,122,138,…)` 与主色 `#0f7685`（15,118,133）不是同一个颜色 | theme.css:172、182-183 | 待确认是否改为 `color-mix(primary)` |

---

## 13. 迁移计划（按优先级）

**P0 – 修复可见缺陷（不改视觉方向，0.5 天）**
1. 在 `theme.css` 的 `.dark` 中补齐 D1 所列变量（直接复制 `tokens.css` `.dark` 块里对应行）。
2. 修 `::selection` 文字色（D11），在 animations.css 加 `prefers-reduced-motion`（D17）。
3. 字重：要么把 800 改成 700，要么在 `fonts.css` 的 Google Fonts 链接里补 400（D7）。

**P1 – 接入 token（1–2 天）**
1. 在 `src/styles/index.css` 中把 `tokens.css` 放在 `theme.css` 之前引入，逐步删除 theme.css 中重复的 `:root` / `.dark` / seed 定义，最后让 theme.css 只保留 `@theme inline` 映射和组件类。
2. 在 `@theme inline` 中新增：`--color-success / -solid / -container / -border`、`--color-warning*`、`--color-info*`、`--color-scrim`、`--color-ink-button*`、`--color-destructive-container`；`--text-2xs: 10px`、`--text-xs-plus`（或其他名称）`: 11px`；`--radius-2xl: 20px`、`--radius-3xl: 24px`；`--shadow-island/panel/card/hero/floating/sheet`；`--breakpoint-topbar: 1100px` 等。
3. 用 `--seed-swatch-*` 替换 AppSettingsDialog.tsx:73-76 与 ProjectHome.css:407-421 的色点（D3）。

**P2 – 清理重复（2–3 天）**
1. ProjectHome.css 的 `--ph-*` 全部换成语义 token（D2），`.ph-root.dark` 改用全局 `.dark`。
2. 用 codemod 替换：`text-[10px]/[9px]/[8px]/[10.5px]` → `text-2xs`；`text-[11px]` → 11px 档；原生色板类 → `success/warning/info/destructive`（D4、D6）。
3. 8 个自制模态框迁移到 `ui/Dialog`（D8、D9）；Toast、Sheet、Badge、Select 补成基础组件。

**P3 – 组件规范化（持续）**
1. Button 增加 `command / ink / pill / icon-sm` 变体，替换 `.ollaic-command`、`.ollaic-icon-button`、`.ph-action-pill` 与原生 `<button>`。
2. 原生 `<input>/<textarea>/<select>` 换成 Input / Textarea / Select。
3. 阴影、圆角、z-index、动效时长逐步替换为 token（D5、D12、D18、D21-23），删除 `default_shadcn_theme.css` 与 `.ollaic-chamfer-tr`。
4. 在 ESLint 中加规则（如 `eslint-plugin-tailwindcss` 的 `no-arbitrary-value` 或自定义正则）阻止新增任意字号、原生色板类和硬编码 hex。

---

## 14. 未能确定的事项

- 暗色模式下原本缺失的变量，部分暗色值没有任何代码依据（`--shadow-faint` 0.25、`--surface-dim`、`--chart-3`、`--destructive-container`），在 `tokens.json` 中标注了“待确认”。
- 浅色 `--info` 文本色在代码中没有用例，暂用 `--tertiary`。
- 业务色（类别/情绪/角色）在暗色下是否需要调整亮度未验证（未运行应用、未截图）。
- 以上计数基于静态正则扫描（排除 `*.test.*`），不包含运行时拼接的类名，个别数字可能有 ±少量误差。
- 未运行开发服务器，也未测量真实渲染对比度；对比度问题是根据颜色值推断的。
- 当前分支 `feat/scene-centric-workflow` 有未提交的改动，审查读取的是工作区现状（含这些改动）。
