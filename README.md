# Ollaic GaLaGame Maker

Ollaic GaLaGame Maker（简称 Ollaic）是一个面向 [WebGAL](https://docs.openwebgal.com/) 的桌面可视小说编辑器。它把 `.txt` 脚本组织成可视化节点、场景关系图、素材库和项目发布流程，并提供 AI 辅助写作与资源规划。

## 0.1 功能范围

- 可视化编辑 WebGAL 场景脚本：新增、删除、排序、复制、粘贴和搜索节点。
- 支持常用 WebGAL 指令：对白、旁白、背景、立绘、音频、选项、跳转、变量、标签和结束。
- 场景管理：创建、删除、重命名场景，维护章节名和大纲，查看场景关系图。
- 素材管理：导入背景、CG、立绘、BGM、音效和语音，维护素材元数据与使用提示。
- 角色管理：维护角色资料、别名、关键词、立绘表情和配音音色。
- 运行预览：安装或指定 WebGAL 运行时模板，支持从编辑器跳转到指定句附近预览。
- 项目导出：导出可运行的 WebGAL 项目目录或 zip。
- AI 辅助：对话式修改脚本、创建角色/场景、规划素材、生成变更预览，并在确认后落盘。
- AI 参考资料：上传本地文本文件（设定稿、大纲、草稿）供 AI 阅读取材，可在 AI 面板查看和删除；参考资料不会写入可运行的项目文件。

## 使用方式

1. 打开或创建一个 WebGAL 项目。
2. 在 FlowBoard 输入 Production Brief，运行或恢复 Agent Flow。
3. 从生产流进入脚本视图，编辑生成场景的节点。
4. 在场景关系图中检查跳转、分支和孤立场景。
5. 在素材和角色面板中补齐演出资源。
6. 使用顶部的预览按钮运行本地 WebGAL 运行时。
7. 导出项目，用 WebGAL 的常规部署方式发布。

## 开发

### 环境要求

- Node.js 20+
- pnpm 10+
- Rust stable
- Linux 需要 WebKitGTK、GTK、AppIndicator、librsvg、OpenSSL 和 `pkg-config` 相关开发包

### 安装依赖

```bash
pnpm install --frozen-lockfile
bash scripts/setup-runtime.sh
```

`setup-runtime.sh` 会下载 WebGAL 运行时模板到 `src-tauri/runtime/WebGAL_Template/`。该目录不进入版本库。

### 本地运行

```bash
pnpm tauri:dev
```

Vite 默认使用 `127.0.0.1:1420`，Tauri 会打开桌面窗口。

### Android 开发

Android 原生工程位于 `src-tauri/gen/android/`，使用 SDK 36、JDK 21 和 Android NDK。
终端需要配置 `JAVA_HOME`、`ANDROID_HOME` 和 `NDK_HOME`；环境配置后重新打开终端。
安装 Rust 目标：

```bash
rustup target add aarch64-linux-android
```

日常开发先在 Android Studio 的 Device Manager 中启动 ARM64 虚拟设备，也可以在单独的终端启动：

```bash
emulator -list-avds
emulator -avd YOUR_AVD_NAME
```

将 `YOUR_AVD_NAME` 替换为上一步列出的虚拟设备名称。然后在项目根目录运行：

```bash
pnpm android:dev
```

Tauri 会构建、安装并启动应用，同时启动 Vite；修改前端会热更新，修改 Rust 会重新构建。
按 `Ctrl+C` 停止开发进程，虚拟设备可以继续运行。

构建用于本地安装的 ARM64 调试 APK：

```bash
pnpm android:build --debug
```

APK 输出到 `src-tauri/gen/android/app/build/outputs/apk/`。
不加 `--debug` 则构建 release APK；发布签名需要另行配置。

需要使用 Android Studio 调试时，运行 `pnpm android:open`，并保持这个终端进程运行。
这个命令只打开原生工程并启动开发服务；后续同步、构建和运行由 IDE 控制。

1. 在 Settings → Build, Execution, Deployment → Build Tools → Gradle 中，将 Gradle JDK 设为 JDK 21。
2. 点击 File → Sync Project with Gradle Files，等待同步完成。
3. 在 Build Variants 中选择 `arm64Debug`，与当前 ARM64 工具链保持一致。
4. 在 Device Manager 中启动 ARM64 虚拟设备，顶部运行配置选择 `app`、目标选择虚拟设备，然后点击 Run。

日常需要自动构建、安装和启动时，使用 `pnpm android:dev`。切换这两个命令前，先按 `Ctrl+C` 停止正在运行的开发进程。

当前先完成 Android 工程和启动基础。手机布局、触控操作、应用内项目存储及文件导入导出仍需继续适配。

### 验证

```bash
pnpm build
pnpm test
```

Linux Fedora 依赖示例：

```bash
sudo dnf install -y webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel pkgconf-pkg-config curl wget file
```
