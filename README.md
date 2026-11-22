# Antigravity Font Tuner

轻量、非侵入式的 Antigravity 字体与排版调节插件。**不修改 `app.asar` 与语言服务二进制文件**，通过 Antigravity 官方 Sidecar 机制与本地调试端口注入精细作用域 CSS，支持全局 UI 字体统一、Chat 与代码块独立字号（突破官方设置 16px 上限）、行高/段距/字距调节，以及本机与免安装自定义字体加载。

> Lightweight, zero-dependency font & typography plugin for Antigravity (`>16px` chat font size, global UI font unification, independent code fonts, line/paragraph/letter spacing, and automatic local/custom font loading) without patching `app.asar`.

---

## 核心特性 / Features

- **Chat 正文与代码块独立字号（突破 16px 限制）**：默认 `20px`，面板滑块支持 `12px ~ 32px`，不影响左侧 Session 列表和整体界面缩放比例。
- **全局 UI 字体统一（可开关）**：可选将侧边栏、按钮、表单、标签栏等全局 UI 字体一并替换，同时**严格避开 `.codicon` / SVG 图标字体、`.monaco-editor` 代码编辑器与终端渲染**，不出现豆腐块也不破坏光标对齐。
- **Chat 精细排版**：独立调节**正文行高**、**代码行高**、**段落行距**、**正文字距**与**编程连字**（`calt` / `liga`）。
- **跨平台零配置字体识别 + 免安装自定义字体目录**：
  - 自动读取 Windows / macOS / Linux 系统与用户字体目录（轻量级仅读文件头元数据，支持中文字族识别）；
  - 自动桥接被内置规则遮蔽的字体（如 `Inter`）及特定字重子样式（如 `MiSans Medium`）；
  - 面板内置**“打开字体目录”**按钮：把 `.ttf` / `.otf` / `.woff2` 拖入专用 `fonts/` 目录后点击“重新扫描”，即可免装系统字体直接使用。
- **事件驱动低功耗内核**：
  - 稳态下依赖网页内 `MutationObserver` 与 CDP `executionContextCreated` 事件恢复，消除高频盲轮询；
  - 使用 OS `fs.watch` 监听配置与自定义字体目录变更；
  - 零第三方 npm 依赖，开箱兼容 Antigravity 自带 Node.js 运行时。

---

## 快速安装 / Quick Start

### 方式一：命令行一键安装

```bash
git clone https://github.com/bpbai/antigravity-font-tuner.git antigravity-font-tuner
cd antigravity-font-tuner

# 1. 安装插件到 ~/.gemini/config/plugins/antigravity-font-tuner
node install.mjs install

# 2. 检测并开启 Antigravity 本地 CDP 调试端口（仅首次需要）
node install.mjs enable-cdp
```

安装完成后，**完全退出并重新从更新后的快捷方式启动 Antigravity** 即可生效。随后可在右侧扩展/辅助面板打开 **Font Tuner** 进行实时调节（改动即刻生效，无需重启）。

### 方式二：让 Antigravity Agent 自动安装

把本仓库中的 [`SKILL.md`](./SKILL.md) 交给 Antigravity 对话框并让它按指引部署即可，AI 会自动执行安装、检查快捷方式 CDP 参数并验证状态。

---

## 自定义字体说明（无需安装到系统）

如果你下载了 `.ttf`、`.otf` 或 `.woff2` 字体文件但不想安装进操作系统：

1. 在 Antigravity 右侧打开 **Font Tuner** 面板；
2. 点击底部的 **「打开字体目录」**（路径位于 `~/.gemini/antigravity/sidecar_data/antigravity-font-tuner/font_tuner/data/fonts/`）；
3. 将字体文件直接拖入该文件夹，返回面板点击 **「重新扫描」**；
4. 在字体下拉框中选择对应字体族点击「设为首选」→「应用并保存」即可。

---

## 为什么不改 `app.asar`？

- **更新不失效**：Antigravity 自动更新或安装其他主题/胶囊类插件（如 `agy-capsule` 等）不会覆盖本插件；
- **安全可逆**：只注入页面运行时 `<style>` 与标准 `FontFace`，停用插件或卸载后零残留；
- **共存友好**：精确避开了 `.agy-composer-footer`、`#agy-capsule-host`、`[data-agy-capsule-subagent]` 与 `.monaco-editor`。

---

## 运行测试 / Tests

```bash
node test.mjs
```

---

## 卸载 / Uninstall

```bash
# 仅卸载插件，保留个人配置与 custom fonts
node install.mjs uninstall

# 完全卸载并清除配置与自定义字体目录
node install.mjs uninstall --purge-data
```

## License

[MIT](./LICENSE)
