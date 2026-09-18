# agent-harness cassettes

每个子目录是一盒录音（cassette）：一次 Agent 运行中，所有经过
`ChatGateway::complete` 的真实 provider 往返。`cargo test --features agent-harness`
会离线重放它们，把 Agent 自己的契约校验压在**模型真实返回过的内容**上。

## 目录布局

| 文件 | 必需 | 作用 |
|---|---|---|
| `cassette.json` | 是 | 录下的往返。按请求哈希查找，不按顺序 |
| `plan.json` | 回归用 | 录制时喂给 Agent 的 StoryPlan |
| `fixture.json` | 回归用 | `{ agent, brief?, instruction?, allowLocalFallback? }` |
| `expected.json` | 可选 | 序列化后的 `AgentOutput`，重放结果必须逐字段相等 |
| `blobs/` | 媒体 | 二进制产物，按 sha256 命名 |

只有 `cassette.json` 的目录会被当成「留档」跳过，不参与回归。

## 录一盒新的

```bash
export OLLAIC_CONFIG_DIR=/tmp/agent-harness-profile   # 别用日常配置
agent-harness --profile "$OLLAIC_CONFIG_DIR" --record outline-01 \
       agent outline --project /path/to/project
```

然后把录制时用的 StoryPlan 复制成 `plan.json`、写一份 `fixture.json`，
需要锁定产物就再生成 `expected.json`：

```bash
agent-harness --replay outline-01 agent outline --scenario <fixture>/plan.json --json \
  > src-tauri/fixtures/agent-harness/outline-01/expected.json
```

## 重放失败怎么读

报错会打印期望与实际 prompt 的行级 diff。意思是这盒录音是给另一段 prompt 录的：
改动是有意的就重录，是误改就改回去。

chain 尤其依赖这一点——第 N 步的 prompt 由第 N-1 步的产出拼成，只重录中间某一盒
会让后面的步骤拿到一份「针对旧输入生成的输出」，那种组合真实运行里不会出现。

## 凭据

录制路径会把配置里的 API Key 以及 `bearer …` / `api_key=…` 形态的内容抹成
`[REDACTED]` 再落盘。即便如此，**提交前扫一眼**——cassette 里存的是完整
prompt，如果你的项目上下文本身含有不该进仓库的内容，它会一起被录进去。

## 整条链路

`agent-harness --record full chain` 会给每个步骤录一盒 `full-<步骤 id>`。重放时缺盒
子不算错——`sceneScript` 步本地编译、不调模型，本来就没有 cassette。

`full-chain-expected.json` 是跑完 7 步后的 StoryPlan，重放必须逐字段复现它。

## 现有 cassette

真实录制，provider `deepseek` / 模型 `deepseek-flash`：

- `outline-deepseek` — 单 Agent 回归：一次 Plotter 调用，带 `plan.json` /
  `fixture.json` / `expected.json`。
- `full-plan` … `full-assetPlan` — 整条链路，由内置覆盖 Brief
  （`harness::chain::COVERAGE_BRIEF`）驱动，6 盒共 6 次模型调用。
