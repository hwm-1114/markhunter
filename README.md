<div align="center">

# MarkHunter 马克猎手

**执笔即江湖，所写皆锋芒**

A Windows desktop Markdown / text editor built for large files, multi-window editing, document diffing and AI assistance.

[![Release](https://img.shields.io/github/v/release/hwm-1114/markhunter?label=%E6%9C%80%E6%96%B0%E7%89%88&color=blue)](https://github.com/hwm-1114/markhunter/releases/latest)
[![Build & Release](https://github.com/hwm-1114/markhunter/actions/workflows/release.yml/badge.svg)](https://github.com/hwm-1114/markhunter/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-green.svg)](LICENSE)
![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%2010%2F11%20x64-lightgrey)
![E2E](https://img.shields.io/badge/%E5%86%92%E7%83%9F%E6%B5%8B%E8%AF%95-179%20%E9%A1%B9%E9%80%9A%E8%BF%87-brightgreen)

[📥 下载安装包](#-安装与下载) · [✨ 功能特性](#-功能特性) · [⌨️ 快捷键](#️-快捷键) · [🛠 参与开发](#-开发运行) · [🔒 隐私与安全](#-隐私与安全) · [📖 更新日志](CHANGELOG.md)

</div>

基于 **Electron 43 + CodeMirror 6 + Tailwind v4 / daisyUI 5** 的 Windows 桌面 Markdown / 文本编辑器。为「重文档工作者」打造：超大文件秒开、多窗口并行、文档级 diff、AI 辅助写作，内置 56 款主题皮肤。

## ✨ 功能特性

**核心亮点**

- 🐘 **大文件分层打开（≤4GB）**：小文件直开、中大文件分段编辑、**>256MB 只读滑窗查看器**（秒开 + 翻页 + 跳转 + 区域编辑写回）
- 🪟 **多窗口同时编辑**：每窗口独立目录/标签，事件按窗口精确路由，同文件跨窗口自动只读 + 静默同步
- 📂 **多目录侧栏 + 拖拽传输**：侧栏同时打开多个目录，树内拖拽 = 移动、Ctrl+拖拽 = 复制，跨目录互传
- 🔀 **多文档对比**：双栏 / 三方 diff、词级高亮、变更块导航、统计与报告导出
- 🤖 **AI 助手**：OpenAI 兼容接口（DeepSeek 预置），读取/修改文档、搜索、建文件；API Key 本机 DPAPI 加密
- 🎨 **56 款主题皮肤**：含 20 款动态特效（极光 / 樱花雨 / 字符雨 / 星空 / CRT 扫描线 / 蒸汽波…），切换即整窗预览

**文件管理**

- 目录树懒加载浏览（图标、大小显示），新建 / 重命名 / 删除（带确认）
- **收藏目录**：工具栏 ⭐ 一键收藏当前工作目录，列表点击直达
- **多目录侧栏**：根行右键切换活动目录 / 关闭（✕ 仅移出侧栏不删文件），目录列表跨重启恢复；根间嵌套拒绝、上限 12 个
- **跨目录拖拽**：拖到目录行 = **移动**，**Ctrl+拖拽 = 复制**（目录递归传输）；同名冲突可选**覆盖**（目录合并）或**保留两者**（自动改名「名 (2).扩展名」），移动后已打开标签自动跟随新路径

**多标签编辑**

- `.md / .txt / .json / .py` 语法高亮，未保存圆点标记，自动保存（间隔可调）
- Tab 缩进（默认 4 空格，可调 1~8，Shift+Tab 反向缩进）
- **滚动位置记忆**：切换标签记住离开时的位置（编辑器 / 图片 / 预览分别记忆）
- 状态栏「↑ 顶部 / ↓ 底部」一键直达文档首尾；100+ 标签键入零劣化，会话最多恢复 200 标签
- **固定（Pin）**：右键标签固定，批量关闭其它 / 右侧 / 左侧（自动跳过已固定标签）

**Markdown 预览**

- 编辑 / 分屏 / 仅预览三模式（Ctrl+B），分隔条可拖拽，mermaid 图渲染，Ctrl+滚轮缩放
- **树自动定位**：查看文件时左侧目录树自动展开定位；工作目录外的文件显示在「外部文件」分支

**图片**

- 文件树点击查看图片/PDF：滚轮缩放、拖拽平移、右键复制原图 / 在文件夹中显示
- Markdown 中粘贴图片自动保存到同目录并插入引用
- 预览图片右键：**复制原图（不压缩）**、在文件夹中显示、打开查看器
- 双击图片打开详情查看器：操作条紧贴图片下方、滚轮以光标为锚点缩放、拖拽平移、**1:1 原始尺寸**（双击切换）、Esc 关闭

**搜索与替换**

- 文件内查找（Ctrl+F / Ctrl+H）：全部匹配列表、点击跳转、编辑器同步高亮；替换当前 / 全部替换
- 全局搜索（Ctrl+Shift+F）：按文件分组、点击打开定位；结果支持跨文件批量替换（带确认）

**Python 运行**

- 运行当前 `.py`，解释器自动检测（PATH / 注册表 / 常见路径）或手动选择
- 内嵌输出面板（stdout / stderr 分色、退出码、耗时），可终止（含进程树）

**AI 助手**

- **任意 OpenAI 兼容服务**：服务商预设一键填入（DeepSeek / OpenAI / 硅基流动 / Kimi / 智谱 / 通义 / Ollama / LM Studio），中转站裸域名自动补 /v1，局域网本机模型可用；「拉取模型列表」在线获取可选模型
- **流式回复 + 思考过程**：打字机实时输出；推理模型（如 deepseek-reasoner）的思考过程折叠显示
- function calling 读取 / 修改文档、全局搜索、新建文件；修改前可设置确认提示
- API Key 经 Windows DPAPI 加密存储在本地，界面不显示明文；支持一键清空对话

**多窗口同时编辑**

- Ctrl+Shift+N 新建窗口 / 二次启动自动在已有实例中开窗（单实例锁）
- 每窗口独立目录 / 标签 / 面板；文件变更、Python 输出、AI 事件、对话框按窗口精确路由
- 设置与主题跨窗口即时同步
- 同文件跨窗口：后来窗口自动只读（🔒 徽标，右键标签可解除），编辑窗口保存后只读窗静默同步（不闪不抖）

**多文档对比**

- 工具栏「🔀 对比」：当前文档 ↔ 其它打开标签 / 剪贴板 / 磁盘版本（未保存改动）
- 文件树右键「设为对比基准」→ 另一文件「与基准对比」直达
- 双栏 diff：行级增 / 删 / 改 + 词级内联高亮、变更块 ↑↓ 导航、+N −M ~K 统计、交换左右、导出 Markdown 报告
- **三方对比**：基准 · 本方 · 对方三栏视图，「双方改同行」高亮潜在冲突行
- 超长内容保护：单侧 >20MB 截断对比（醒目横幅）、超长行截断显示、分批渲染

**会话保持**

- 切换工作目录不丢失已打开标签；重启自动恢复上次标签与活动标签（含固定状态）
- 外部文件（工作目录外）自动归入「外部文件」分支，可按真实路径链定位

**安全加固**

- 渲染进程沙箱、contextIsolation、CSP、导航防护
- 文件操作路径校验（防目录穿越）、设置白名单、Python 运行校验
- asar 完整性 + Electron Fuses（runAsNode 禁用等）

## ⌨️ 快捷键

| 快捷键 | 功能 |
|---|---|
| Ctrl+O | 选择目录（多目录侧栏：追加目录） |
| Ctrl+S | 保存当前文件 |
| Ctrl+F / Ctrl+H | 文件内查找 / 定位到替换输入框 |
| Ctrl+Shift+F | 全局搜索（结果支持批量替换） |
| Ctrl+Shift+N | 新建窗口（多窗口同时编辑） |
| Ctrl+B | 预览模式切换（编辑 / 分屏 / 仅预览） |
| Ctrl+0 | 预览缩放重置 |
| Ctrl+W | 关闭当前标签 |
| Ctrl+Tab / Ctrl+Shift+Tab | 循环切换标签 |
| Tab / Shift+Tab | 缩进 / 反向缩进 |
| Esc | 关闭右键菜单 / 弹窗，收起底部面板 |

## 📦 安装与下载

1. 前往 [**Releases**](https://github.com/hwm-1114/markhunter/releases/latest) 下载 `MarkHunter-Setup-<版本>.exe`（Windows 10/11 x64）
2. 双击安装，可自选安装目录
3. 未签名应用首次运行可能触发 Windows SmartScreen：点击「更多信息」→「仍要运行」

> 免安装使用：应用为绿色单进程设计，卸载仅删除安装目录即可；用户配置保存在 `%APPDATA%\MarkHunter\`。

## 🛠 参与开发

**环境要求**：Windows 10/11 · Node.js ≥ 20 · npm

```bash
git clone https://github.com/hwm-1114/markhunter.git
cd markhunter
npm install       # 安装依赖（Electron 走 npmmirror 镜像）
npm start         # 启动应用
npm run build     # esbuild 打包渲染进程（改渲染端源码后必须执行）
npm run smoke     # 端到端冒烟测试（179 项，真实窗口自动化验证）
npm run release   # 本地打包 NSIS 安装包
```

发布：更新 `package.json` 版本与 `CHANGELOG.md` → 推送 tag `vX.Y.Z` → CI 自动构建并发布到 GitHub Releases。

**技术栈**：Electron 43 · CodeMirror 6 · markdown-it · mermaid · Tailwind v4 / daisyUI 5 · esbuild

**目录结构**

```
src/
├─ main/       # 主进程（CJS）：窗口、文件 IPC 与编码检测、安全白名单、
│              #   文件监听、全局搜索 worker、设置与主题、AI / Python
├─ preload/    # contextBridge：仅暴露 window.api.*（IPC 白名单镜像）
└─ renderer/   # 渲染端（ESM → esbuild IIFE）：标签编辑、文件树、预览、
               #   搜索、对比、查看器、AI 面板、主题引擎
```

## 🔒 隐私与安全

- **零遥测**：不采集、不上报任何数据；仅当你配置并使用 AI 助手时访问你指定的 API 服务
- **API Key 本地加密**：经 Windows DPAPI（safeStorage）加密后保存在本机 `settings.json`，永不回显明文
- **文件操作白名单**：写入 / 删除 / 改名均经主进程路径校验（仅限已打开目录内），防目录穿越
- **打包加固**：asar 完整性校验 + Electron Fuses（禁用 runAsNode 等）

## 📖 更新日志

各版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 📄 许可证

[MIT](LICENSE) © 2026 VibeCode
