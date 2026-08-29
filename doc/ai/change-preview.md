# 修改预览与应用

AI 的所有写操作不会直接改动磁盘,而是聚合成一个**待确认变更集(PendingChangeSet)**,由用户在卡片中预览、同意或拒绝。确认后,前端通过一个后端命令提交整个变更集。

## 变更集聚合

所有暂存编辑(场景、角色、记忆、新建场景)合并为单个 `PendingChangeSet`。场景编辑包含修改前/后节点、diff(基于 LCS 计算)以及素材校验。
- 实现:`lib/change-set.ts`(`stageSceneEdit` 等)、`finalizeChangeSet`(`useAiAgent.ts`)。

## 预览展示

- **变更卡片** `AiPendingCard` / `ChangeSetCard`:汇总全部变更(数量 + 每项明细)。场景编辑显示**节点级 diff**——新增/修改/删除的节点卡(带命令图标),原始文本 diff 可折叠展开。
- **主画布预览**:当待确认变更涉及当前打开的场景时,主画布以只读形式渲染节点 diff(绿=新增 / 红=删除 / 黄=修改),用 `PreviewNodeCard` 完整呈现;聊天面板内用紧凑的 `MiniNodeCard`。
- **跨场景请求**:AI 思考时切换场景不会取消本轮请求;请求继续基于发起时的场景快照生成变更集。若完成时用户已经切到其他场景,只显示变更卡片,不改写当前画布;切回目标场景后会看到对应 diff。接受时若当前缓冲仍是原始内容或 AI 预览,直接落盘;只有用户在暂存后手动改过目标场景时才进入冲突。

## 同意 / 拒绝 / 冲突

- **同意**:`acceptChange` 把类型化变更集交给后端。后端在项目锁内重新检查冲突并提交;前端仅在后端确认成功后更新画布、历史和内存状态。
- **拒绝**:`revertChange` 丢弃暂存。
- **冲突**:若在变更待确认期间用户手动改了当前场景,会出现冲突卡 `ConflictCard`,提供三选项:保留手动修改 / 应用 AI(覆盖)/ 基于最新状态重新生成(`regenerateAfterConflict` 会预填提示词)。

## 缺失素材

若补丁引用了素材库中不存在的资源,`MissingAssetCard` 提供:使用兜底素材 / 打开素材库 / 重试该提示。
- 实现:`stageSceneEdit`(`change-set.ts`)、`AiStatusCard.tsx`。

## 补丁执行引擎（基于锚点）

AI 生成的修改是以行为单位的补丁（`EditorPatch`）。为了防止在用户打字和 AI 响应并行时造成的行号漂移问题，编辑器引入了**基于锚点的执行引擎**（`editor-executor.ts`）。
该引擎在应用补丁时不仅依赖于 `startLine`/`endLine`，还会利用 `anchorText` 结合上下文自动寻找匹配的目标行。如果精确行号无法匹配，引擎会在行号前后容错搜索相同的 `anchorText` 从而解决跨端并发写入引发的覆盖错行问题。

## 原子落盘与恢复

`apply_ai_change_set` 是变更集提交的唯一边界。它在同一把项目锁内完成以下流程:

```text
重新读取冲突基线 -> 创建项目恢复快照 -> 写入全部资源 -> 删除恢复快照
                                  |
                                  +-- 任一步失败 -> 恢复快照
```

场景、角色、项目记忆、素材元数据和新建场景使用类型化请求,不通过松散 JSON 对象传递。场景写入产生的背景素材卡也在事务内同步。现有的对应独立写命令复用同一把项目锁,避免它们插入冲突检查与提交之间。

后端返回三类结果:

- `applied`:全部资源已提交。此时前端才更新可保存的编辑缓冲。
- `conflict`:资源已在预览后变化,磁盘未写入。普通同意会停在冲突卡;强制应用只跳过冲突检查,不会提前修改画布。
- `failed`:同时说明失败资源和恢复状态。`not_needed` 表示提交前失败、项目未写入;`restored` 表示项目已恢复到提交前状态;`recovery.failed` 表示可能存在部分写入,自动恢复快照会保留并显示其 ID,用户应先在快照管理中手动恢复。

实现入口:`src-tauri/src/ai/change_set.rs` 中的 `apply_ai_change_set`,前端调用位于 `design/src/app/lib/ai-change-set-ipc.ts`。

## 相关源码
- `design/src/app/lib/change-set.ts`、`design/src/app/lib/editor-patch.ts`、`design/src/app/lib/editor-executor.ts`（锚点定位与补丁执行）
- `design/src/app/hooks/useAiAgent.ts`(`finalizeChangeSet` / `acceptChange` / `revertChange` / `forceApplyChange` / `persistChangeSet`)
- `src-tauri/src/ai/change_set.rs`(`apply_ai_change_set`)
- `design/src/app/components/AiPendingCard.tsx`、`AiStatusCard.tsx`、`MiniNodeCard.tsx`、`PreviewNodeCard.tsx`
- `design/src/app/lib/node-diff.ts`(节点级 diff)
