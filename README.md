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

See [Development Standards](DEVELOPMENT.md) for the English directory-level rules, starting with [AGENTS.md](AGENTS.md).

### Repository layout

- `apps/desktop/`: Desktop application, with React/Vite source and frontend tooling.
- `apps/desktop/src-tauri/`: Desktop Rust backend, native capabilities, and Tauri configuration.
- `apps/android/`: Native Kotlin/Jetpack Compose application.
- `apps/ios/`: Native SwiftUI application for iPhone and iPad.
- `crates/`: Shared WebGAL project core, preview hosting, and UniFFI interfaces.
- `bindings/swift/`: Host integration checks for generated Swift bindings.
- `scripts/`: Shared development and release tooling.

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

`setup-runtime.sh` 会下载 WebGAL 运行时模板到 `apps/desktop/src-tauri/runtime/WebGAL_Template/`。该目录不进入版本库。

### 本地运行

```bash
pnpm tauri:dev
```

Vite 默认使用 `127.0.0.1:1420`，Tauri 会打开桌面窗口。

### Android Development

The native Kotlin / Jetpack Compose application lives in [`apps/android/`](apps/android/README.md).
It calls the shared Rust project core through UniFFI and uses Material 3 with the Ollaic palette.
It does not bundle the desktop frontend, Tauri, or the matting model.
WebView hosts local WebGAL playtesting and isolated SVG previews.

Requires JDK 21, Android SDK 36, an Android NDK, and Rust stable. The default ABI is ARM64:

```bash
rustup target add aarch64-linux-android
```

Start an emulator in Android Studio's Device Manager or from the terminal:

```bash
emulator -list-avds
emulator -avd YOUR_AVD_NAME
```

Replace `YOUR_AVD_NAME` with an installed virtual device name, then run from the repository root:

```bash
pnpm android:dev
```

This builds, installs, and launches the native app on one running emulator.
Set `ANDROID_SERIAL` to select a device explicitly. To build without installing:

```bash
pnpm android:build
```

The APK is `apps/android/app/build/outputs/apk/debug/app-debug.apk`.
`pnpm android:open` opens the Gradle project in Android Studio; select JDK 21 and
sync before running its `app` configuration. See the [Android guide](apps/android/README.md)
for NDK selection and ABI configuration.

Android uses real WebGAL projects with structured command editing, scene management,
character and asset catalogs, and ZIP import/export. See [native mobile integration](docs/mobile/README.md)
for compatibility, draft migration, and pending features, and the
[validation workflow](docs/mobile/validation.md) for test coverage.

Run the integrated native tests on one selected emulator:

```bash
ANDROID_SERIAL=emulator-5554 pnpm android:test
```

Native Android keeps the application ID used by the former Tauri build. In-place upgrades retain private files, but the native app does not read the old Web project library. Uninstalling the app removes its private data.

### iOS 开发

独立的 SwiftUI 工程位于 [`apps/ios/`](apps/ios/README.md)，支持 iOS 17+ 的 iPhone 和 iPad。构建需要 macOS、Xcode 15+ 和 iOS SDK；运行还需要在 Xcode 中安装 iOS 17+ Simulator 系统。

```bash
pnpm ios:open
pnpm ios:build
pnpm ios:dev
```

`ios:open` 打开 Xcode 工程；`ios:build` 构建无需签名的 Debug 模拟器应用；`ios:dev` 默认选择并启动普通 iPhone，没有对应设备时自动创建，随后构建、安装并启动应用。通过 `IOS_SIMULATOR_UDID` 可指定已有模拟器，包括 iPad 或 iPhone Duo。runtime 的安装和删除在 Xcode → Settings → Components 中管理；Xcode 27 的 Apple Silicon Mac 可运行 `xcodebuild -downloadPlatform iOS -buildVersion 27.0 -architectureVariant arm64` 安装普通 iPhone 所需的系统。

原生首页支持本地草稿的新建和编辑、简介与封面颜色、收藏、搜索、排序、列表/网格、最近项目和回收站。项目打开后进入原生编辑器，可管理场景，编辑对白、旁白和备注，保存创作笔记，并撤销/重做。iPhone 使用底部切页，iPad 展开场景侧栏；草稿在应用私有目录中原子保存。当前草稿尚未初始化为 WebGAL 工程，素材导入、预览、导出、AI 和共享 Rust 核心尚未接入。构建不依赖 React、Tauri、Rust 或抠图模型。详见 [`apps/ios/README.md`](apps/ios/README.md)。

The shared core also exposes Swift UniFFI bindings. On macOS, `pnpm bindings:test:swift`
generates and compiles them, then validates project creation, editing, persistence,
and ZIP round trips. Integration into the iOS app remains pending.

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
