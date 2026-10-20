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

独立的 Kotlin / Jetpack Compose 原生应用位于 [`android/`](android/README.md)，使用 Material 3 和 Ollaic 品牌配色。这个 Gradle 工程不依赖 React、WebView 或 Tauri，不打包桌面前端、Rust 动态库和抠图模型。

需要 JDK 21 和 Android SDK 36；当前首页原型不需要 NDK 或 Rust 工具链。先在 Android Studio 的 Device Manager 中启动虚拟设备，也可以在终端启动：

```bash
emulator -list-avds
emulator -avd YOUR_AVD_NAME
```

将 `YOUR_AVD_NAME` 替换为上一步列出的虚拟设备名称。然后在项目根目录运行：

```bash
pnpm android:dev
```

这个命令构建调试 APK，安装到正在运行的模拟器并启动应用，不启动 Vite。默认只选择模拟器；需要指定设备时设置 `ANDROID_SERIAL`。

只构建调试 APK：

```bash
pnpm android:build
```

APK 输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。也可以直接运行 `android/gradlew -p android :app:assembleDebug`，整个构建不调用桌面工具链。

使用 Android Studio 时运行 `pnpm android:open`，或直接打开 `android/`：

1. 在 Settings → Build, Execution, Deployment → Build Tools → Gradle 中，将 Gradle JDK 设为 JDK 21。
2. 点击 File → Sync Project with Gradle Files，等待同步完成。
3. 在 Build Variants 中选择 `debug`。
4. 在 Device Manager 中启动虚拟设备，顶部运行配置选择 `app`、目标选择虚拟设备，然后点击 Run。

原生首页支持系统深色模式、搜索、筛选、列表/网格切换，以及本地草稿的创建、编辑、收藏和回收站。这些草稿只保存首页元数据，不是已经初始化的 WebGAL 工程；ZIP 导入暂时禁用。后续通过共享 Rust 核心和原生绑定接入完整项目功能。

旧 Tauri Android 测试工程仍在 `src-tauri/gen/android/`，对应命令为 `pnpm android:tauri:dev`、`pnpm android:tauri:build --debug` 和 `pnpm android:tauri:open`，需要额外的 NDK 和 Android Rust 目标。它不参与独立原生应用的构建。

旧 Web 首页保留了移动端私有目录和 ZIP 导入适配，ZIP 最大 512 MiB、解压后最大 2 GiB。独立原生应用不会读取旧 Web 项目列表。两种 Android 构建沿用同一应用 ID，覆盖安装保留私有文件，卸载会删除私有数据。

### 验证

```bash
pnpm build
pnpm test
```

Linux Fedora 依赖示例：

```bash
sudo dnf install -y webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel pkgconf-pkg-config curl wget file
```
