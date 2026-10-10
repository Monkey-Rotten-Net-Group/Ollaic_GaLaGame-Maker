# 素材管理

集中管理项目的背景、立绘、音频(BGM/音效/语音)与 CG 等素材,支持上传、分类、别名/元数据、用量提示与素材选择器。

## 子文档

| 文档 | 内容 |
|------|------|
| [素材库](./asset-library.md) | 分类标签、上传、配额、视图、删除与用量提示、与 game/ 目录映射 |
| [元数据与别名](./metadata.md) | 别名、描述、参考素材、场景卡、语音卡 |
| [配音管理](./voice-dubbing.md) | 配音清单面板、按场景/角色过滤、批量/单句 AI TTS 生成、本地导入 |
| [资产任务队列](./asset-task-queue.md) | Agent Flow 资产调度、并发限流、Artifact、自动重试与绑定 |

## 总览

- **素材库中心**:`AssetManager.tsx`,标签页组织背景/CG/音乐/语音/角色(立绘)。其中包含独立的 `VoiceDubbingPanel` 处理配音进度。
- **素材选择器**:`AssetPicker.tsx`,在详情面板等处快速挑选素材,带音频试听与缩略图。
- **元数据**:`lib/asset-metadata.ts`,为素材记录别名、描述、参考资料,以及生成用的「场景卡 / 语音卡」。
- 图片、立绘和配音可由 AI 生成(见 [AI 素材与立绘生成](../ai/media-generation.md)); BGM/音效由用户上传。
- Agent Flow 通过 AssetTaskQueue 自动生成并绑定背景、立绘和逐句语音；BGM/音效任务仅保留本地占位与队列兼容能力。

## 相关源码
- `design/src/app/components/AssetManager.tsx`、`design/src/app/components/AssetPicker.tsx`、`VoiceDubbingPanel.tsx`
- `design/src/app/lib/asset-metadata.ts`、`design/src/app/lib/assets-ipc.ts`
