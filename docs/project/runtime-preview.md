# 运行预览

This page describes desktop preview. Native Android playtesting starts from the game
entry point; see [native runtime preview](../mobile/runtime-preview.md).

在本地运行 WebGAL 运行时预览作品,并可从编辑器**跳转到指定对白**。

## 预览服务

- 本地运行时服务于 `http://127.0.0.1:{port}/`。
- `setRuntimeProject(projectPath)`:将运行时 `/game/*` 指向当前项目。
- `setRuntimeTemplateDir(dir)`:覆盖 WebGAL 模板目录(自定义运行时 UI)。
- `openInBrowser(runtimeUrl)`:用系统浏览器打开预览。

## 跳转导航

- `jumpToSentence(sceneName, sentenceNumber)`:让运行时快进到指定对白节点(通过 WebSocket 调试协议广播,支持实验性「快速同步」)。
- 在编辑器点击对白节点的「预览」即调用。

## 调试协议

编辑器 ↔ 运行时基于 WebSocket 消息总线:JUMP、SYNCFC、SYNCFE、TEMP_SCENE、SET_COMPONENT_VISIBILITY、EXE_COMMAND、SET_EFFECT 等。

## 运行时安装

- 自动检测或下载 WebGAL 发行版,安装到应用数据目录;开发环境也可使用 `scripts/setup-runtime.sh` 准备本地模板。
- 跟踪状态:`installed`、`version`、`path`(在应用设置中管理)。

## 相关源码
- `apps/desktop/src/app/lib/webgal-ipc.ts`(`setRuntimeProject` / `setRuntimeTemplateDir` / `jumpToSentence` / `getRuntimeInfo` / `installRuntime`)
- `apps/desktop/src/app/components/StoryEditor.tsx`(`handleOpenRuntime`、`jumpToNode`)
