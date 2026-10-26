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

原生首页支持系统深色模式、搜索、筛选、列表/网格切换，以及本地草稿的创建、编辑、收藏和回收站。草稿元数据与工作区内容保存在应用私有目录，尚未初始化成 WebGAL 工程；ZIP 导入暂时禁用。后续通过共享 Rust 核心和原生绑定接入完整项目功能。

点击项目卡片可进入独立原生工作区，支持场景管理、对白/旁白/备注草稿、撤销重做和创作笔记。手机使用底部导航，宽屏展开场景侧栏；草稿自动保存，返回项目库前会完成保存。当前保存的是 Android 本地工作区 JSON，运行预览、素材导入和 Agent 尚未接入 WebGAL/Rust 后端。

旧 Tauri Android 测试工程仍在 `src-tauri/gen/android/`，对应命令为 `pnpm android:tauri:dev`、`pnpm android:tauri:build --debug` 和 `pnpm android:tauri:open`，需要额外的 NDK 和 Android Rust 目标。它不参与独立原生应用的构建。

旧 Web 首页保留了移动端私有目录和 ZIP 导入适配，ZIP 最大 512 MiB、解压后最大 2 GiB。独立原生应用不会读取旧 Web 项目列表。两种 Android 构建沿用同一应用 ID，覆盖安装保留私有文件，卸载会删除私有数据。

### iOS 开发

独立的 SwiftUI 工程位于 [`ios/`](ios/README.md)，支持 iOS 17+ 的 iPhone 和 iPad。构建需要 macOS、Xcode 15+ 和 iOS SDK；运行还需要在 Xcode 中安装 iOS 17+ Simulator 系统。

```bash
pnpm ios:open
pnpm ios:build
pnpm ios:dev
```

`ios:open` 打开 Xcode 工程；`ios:build` 构建无需签名的 Debug 模拟器应用；`ios:dev` 默认选择并启动普通 iPhone，没有对应设备时自动创建，随后构建、安装并启动应用。通过 `IOS_SIMULATOR_UDID` 可指定已有模拟器，包括 iPad 或 iPhone Duo。runtime 的安装和删除在 Xcode → Settings → Components 中管理；Xcode 27 的 Apple Silicon Mac 可运行 `xcodebuild -downloadPlatform iOS -buildVersion 27.0 -architectureVariant arm64` 安装普通 iPhone 所需的系统。

原生首页支持本地草稿的新建和编辑、简介与封面颜色、收藏、搜索、排序、列表/网格、最近项目和回收站。项目打开后进入原生编辑器，可管理场景，编辑对白、旁白和备注，保存创作笔记，并撤销/重做。iPhone 使用底部切页，iPad 展开场景侧栏；草稿在应用私有目录中原子保存。当前草稿尚未初始化为 WebGAL 工程，素材导入、预览、导出、AI 和共享 Rust 核心尚未接入。构建不依赖 React、Tauri、Rust 或抠图模型。详见 [`ios/README.md`](ios/README.md)。

### 验证

```bash
pnpm build
pnpm test
```

Linux Fedora 依赖示例：

```bash
sudo dnf install -y webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel pkgconf-pkg-config curl wget file
```

### 发布桌面安装包

根目录 `VERSION` 是发布版本的唯一入口，格式为 `主版本.次版本.修订号`。

1. 把 `VERSION` 升到更大的版本，例如 `0.1.1`。
2. 提交修改并推送或合并到 `master`。
3. 等待 `release` 工作流完成。
4. 在 GitHub Releases 检查草稿的更新说明和三个平台的安装包，再手动点击 `Publish release`。

工作流会自动同步前端、Tauri、Cargo 和锁文件中的应用版本。
Windows、Linux、macOS 的安装包会上传到对应的 `v版本号` Release 草稿，工作流不会自动公开发布。
无需手动创建标签。普通代码提交、其他分支提交和仅修改版本空白不会发布。
首次添加 `VERSION` 时，沿用现有应用版本也不会发布。

版本号必须递增，且不能使用其他提交已有的标签。
工作流会在构建前创建标签，将草稿固定到该提交，后续提交不能移动标签或覆盖该版本的安装包。
构建失败时，Release 保持草稿状态；修复构建后，重新运行失败的工作流。
如果修复需要新的代码提交，请再次升高 `VERSION`。

本地可以检查发布脚本，或同步应用版本：

```bash
node --test scripts/version.test.mjs scripts/release-draft.test.mjs
node scripts/version.mjs sync
```
