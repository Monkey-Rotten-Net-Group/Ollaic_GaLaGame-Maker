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

工作流会自动同步前端、Tauri、Cargo 和锁文件中的应用版本。
Windows、Linux、macOS 全部构建成功后，工作流会公开对应的 `v版本号` Release。
无需手动创建标签。普通代码提交、其他分支提交和仅修改版本空白不会发布。
首次添加 `VERSION` 时，沿用现有应用版本也不会发布。

版本号必须递增，且不能使用其他提交已有的标签。
构建失败时，Release 保持草稿状态；修复构建后，重新运行失败的工作流。
如果修复需要新的代码提交，请再次升高 `VERSION`。

本地可以检查发布脚本，或同步应用版本：

```bash
node --test scripts/version.test.mjs
node scripts/version.mjs sync
```
