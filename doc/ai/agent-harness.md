# agent-harness：AI 链路的命令行调试与回归

`agent-harness` 是一个无界面的小工具，直接驱动后端真实的 AI 代码路径：探测供应商、
单独跑一个 Flow Agent、生成图像/语音/音乐、把真实响应录成 cassette 并离线重放。

它复用的是 Tauri command 背后的同一批函数（`ai::commands::ai_chat_turn`、
`ai::commands::generate_image_media`、`agents::AgentRegistry` 等），所以
`agent-harness` 跑通说明的是**应用本身**跑得通，而不是一份平行实现跑得通。

## 构建与运行

工具在 `harness` feature 之下，正常的 `cargo build` / `tauri build` 不会编译它，
也不会把 clap 打进发布产物。

```bash
pnpm agent-harness <子命令>                      # 最省事，注意不要再加一层 --
cargo run --features agent-harness --bin agent-harness -- <子命令>
# 或者构建一次反复用
cargo build --features agent-harness --bin agent-harness && ./target/debug/agent-harness <子命令>
```

下文一律写作 `agent-harness`。

## 先隔离配置

`--profile <dir>` 会设置 `OLLAIC_CONFIG_DIR`，让这次调用读写指定目录而不是
桌面应用保存的 `~/.config/ollaic/`。**排查供应商问题时一定要带上它**，否则
`probe --provider ...` 会把临时覆盖写回你日常用的配置。

```bash
export LAB=/tmp/agent-harness-profile
agent-harness --profile $LAB config show
```

`config show` 打印 chat / image / tts / music 四套配置、各自的生效 endpoint、
以及日志路径。API Key 只显示 `set(42)` / `unset`，不会打印内容。

## 排查供应商

```bash
agent-harness --profile $LAB probe                     # 校验 + 能力 + 一次真实往返
agent-harness --profile $LAB probe --offline           # 只看配置与声明能力，不发请求
agent-harness --profile $LAB probe --provider custom \
       --base-url https://your-gateway/v1/ --model glm-4.6
```

覆盖参数只在本次调用内生效，调用结束后 profile 会被还原。API Key 可以用
`AI_LAB_API_KEY` 环境变量传，避免留在 shell 历史里。

`probe` 会分别报告三件事，它们是独立失败的：配置能否连上、供应商声明了哪些
能力、以及**带工具定义的一次真实往返能不能成功**。最后一项才是多步 Agent
循环真正依赖的东西。

> Base URL 的结尾斜杠是有意义的。底层 genai 客户端按 URL 拼接规则处理
> `base_url`，`https://host/v1`（无斜杠）会丢掉 `/v1` 段，`https://host/v1/`
> 才是对的。`probe` 报 404/连接错误时先检查这里。

## 跑单个 Agent

```bash
# 用项目里的 StoryPlan（.ollaic/plan.json）
agent-harness --profile $LAB agent outline --project /path/to/project

# 或者用一份独立的 StoryPlan JSON，不需要项目落盘
agent-harness --profile $LAB agent dialogist --scenario plan.json --instruction "多写两章"

# 产物写文件
agent-harness --profile $LAB agent outline --project . -o outline.json
```

可选的 agent：`plan` `memory` `outline` `character` `asset` `scene` `dialogist`。
上下文字段的组装与 `pipeline::scheduler` 里 Flow 的做法一致——改了那边的
`AgentContext`，这边 `agent_harness/scenario.rs` 也要跟着改，否则 `agent-harness` 会开始
说谎。

失败时你看到的就是 Agent 自己的契约错误（例如
`contract violation at $.scenePlans[3].file: must be a unique safe .txt filename`），
包括 `router.rs` 那一轮 JSON 自动修复之后仍然不过的情况。

## 一条 Brief 打通整条链路

```bash
agent-harness --profile $LAB chain                      # 用内置覆盖 Brief
agent-harness --profile $LAB chain "你自己的 Brief"
agent-harness --profile $LAB chain --brief-file brief.md -o plan.json
agent-harness chain --show-brief                        # 只打印内置 Brief，不调用任何东西
agent-harness --profile $LAB chain --stop-after outline # 缩小失败范围
```

`chain` 按真实 Flow 的顺序依次跑完所有 Agent 步骤，每一步都过一遍
`pipeline::output_commit::validate_output_contract`（编排器提交前用的同一道闸），
通过后 `apply_output` 并入 StoryPlan 供下一步使用：

```
STEP        EXECUTOR         TIME  CALL  RESULT
✓ plan      agent          5.2s     1  synopsis 176 字
✓ memory    agent         22.0s     1  worldbook 1655 字, glossary 7 条
✓ outline   agent         28.8s     1  3 章, 8 场景, 8 条边, 4 个选择
✓ character agent         16.1s     1  3 个角色
✓ dialogist dialogist     44.4s     1  8 份草稿, 176 条对白
✓ assetPlan assetPlanner  22.8s     1  16 个素材任务
✓ scene     sceneScript    0.0s     0  8 个场景脚本, 285 行

7/7 步通过 · 139.2s · tokens 24785 in / 30876 out
```

`CALL` 是这一步真实打了几次模型。**`scene` 恒为 0** —— `sceneScript`
把对白草稿本地编译成 WebGAL 文本，不调模型。某一步出现 `2` 说明触发了
JSON 修复轮，表格会额外标一行提示。

步骤表由 `pipeline::dsl::default_recipe()` 派生而不是写死，所以改了 Flow 的步骤
顺序，`chain` 会跟着变；`assetQueue` 步（P2 素材生成，不调 chat 模型）被跳过。

### 内置覆盖 Brief

不带参数时用的是 `harness::chain::COVERAGE_BRIEF`，每一条要求都对着某个下游校验写的：

| Brief 里的要求 | 为了触发 |
|---|---|
| 三章、至少六个场景 | Plotter 的 `chapters` 非空、`scenePlans.len() >= 2` |
| 入口固定 start.txt | Plotter 的 entry scene 校验 |
| 第二章一次分歧、两个结局 | `branches.edges` 至少一条带 `choice` |
| 恰好三个具名角色 + 各自说话方式 | Character 的非空 id/name；Dialogist 的分角色对白 |
| 点名四个地点 + 气氛 | AssetPlanner 分出 background / bgm 任务 |
| 每角色两种表情（平静、动摇） | AssetPlanner 的 figure 任务与 `figureCues` |
| 两个术语及其解释 | Memory 的 glossary |

Brief 的正文在 `fixtures/agent-harness/coverage-brief.md`，按普通文本编辑即可。
它是链路里所有 prompt 的源头，改了之后所有 cassette 都要重录。

## 录制与重放

```bash
# 录：真实打供应商，同时把每次往返落盘
agent-harness --profile $LAB --record outline-01 agent outline --project .

# 放：完全离线，不持有任何网络客户端
agent-harness --replay outline-01 agent outline --scenario plan.json

# 整条链路：每步录一盒，名字是 <前缀>-<步骤 id>
agent-harness --profile $LAB --record full chain
agent-harness --replay full chain
```

录制切面在 `agents::router::ChatGateway::complete`。选这里而不是 HTTP 层是因为
**JSON 修复循环走的是同一个 trait**——「第一次返回坏 JSON → 修复器再来一轮」
这条最值得盯住的路径会被自动录进去。

重放按请求内容查找，不按到达顺序。查不到就说明这盒录音是给另一段 prompt 录的，
报错打印行级 diff：

```
cassette `outline-01` has no interaction for request sha256:86c2…
The prompt changed since recording, or this path was never recorded.

Nearest recorded interaction is #0:

--- user prompt ---
-   8   "synopsis": "转学生在旧校舍里听见不存在的回声。",
+   8   "synopsis": "转学生在旧校舍里听见不存在的回声。（多了一句改动）",
```

chain 尤其依赖按内容匹配：第 N 步的 prompt 由第 N-1 步的产出拼成，只重录中间某一盒
会让后面的步骤拿到一份针对旧输入生成的输出，而那种组合真实运行里不会出现。

cassette 默认放在 `src-tauri/fixtures/agent-harness/`，`--cassette-dir` 可改。目录布局
和如何把一盒录音升级成回归用例，见
[`../../src-tauri/fixtures/agent-harness/README.md`](../../src-tauri/fixtures/agent-harness/README.md)。

```bash
agent-harness cassette ls
agent-harness cassette show outline-01
agent-harness cassette verify outline-01      # 同一段 prompt 没有两份答案
```

写盘前会把配置里的 API Key 与 `bearer …` / `api_key=…` 形态的内容抹掉（复用
`ai::commands::redact_common_secrets`）。但 cassette 存的是完整 prompt，**提交前
仍然要自己看一眼**：项目上下文里不该进仓库的东西也会被一起录进去。

## 离线回归

```bash
cargo test --features agent-harness --manifest-path src-tauri/Cargo.toml
```

两类回归，全程无网络，都已接入 CI：

1. **单 Agent** —— 遍历每盒带 `fixture.json` + `plan.json` 的 cassette，重放并断言
   Agent 的契约校验通过；带 `expected.json` 的还会逐字段比对产物。
2. **整条链路** —— 重放 `full-*` 那组 cassette 跑完 7 步，断言每步都过
   `validate_output_contract`，并把最终 StoryPlan 与 `full-chain-expected.json` 比对。

这是这套机制的意义所在：`agents/outline.rs` 里那套校验（章节非空、scene id 唯一、
文件名安全）此前在 CI 里跑的永远是手写的完美 JSON，现在跑的是模型真的返回过的东西。
一次 139 秒、5.5 万 token 的真实链路，重放只要不到 0.1 秒。

## 其它

```bash
agent-harness --profile $LAB chat "把第 12 行改成旁白" --tools tools.json
agent-harness --profile $LAB media image "夜晚的教室" -o out.png
agent-harness --profile $LAB media tts "早上好" --voice alloy -o out.mp3
agent-harness --profile $LAB log -n 20          # 调用日志
agent-harness --profile $LAB log --trace -n 20  # Agent 轨迹
```

所有子命令都支持 `--json`，输出一个 JSON 值、不夹杂人类可读文本，便于管道处理。

## 不覆盖什么

- **对话式编辑 Agent 的多步循环**。它的提示词、工具定义、工具执行和变更集校验都在
  前端（`design/src/app/lib/ai-tools.ts`、`story-agent.ts`、`change-set.ts`、
  `hooks/useAiAgent.ts`），Rust 只是转发层。`agent-harness chat --tools` 能喂手写的工具
  定义验证供应商侧的 function-calling，但不会跑 `AGENT_TOOLS` 和那个循环本身。
  见 [对话编辑 Agent](./conversational-agent.md)。
- **流式**。`ai_chat_stream` 把 `AppHandle::emit` 写死在函数体里，要支持
  `--stream` 得先把它的核心抽成一个返回 stream 的函数供两边共用。
- **整条 Flow 编排**。`agent-harness agent` 一次跑一个 Agent；编排、恢复、事件由
  `pipeline/tests.rs` 用 mock Agent 覆盖。
