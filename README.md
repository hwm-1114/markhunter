# MarkHunter 马克猎手

> 执笔即江湖，所写皆锋芒。

基于 Electron 的 Windows 桌面 Markdown 编辑器（私有仓库）。

## 功能

- 目录树文件管理、收藏目录、多标签编辑
- .md / .txt / .json / .py 语法高亮、自动保存、大文件保护
- Markdown 预览：编辑/分屏/仅预览三模式、mermaid 渲染
- 文件内搜索（Ctrl+F）、全局搜索（Ctrl+Shift+F）
- 图片查看、Python 运行、设置面板
- 安全加固：API Key 加密存储、Electron Fuses

## 开发运行

```bash
npm install
npm start
```

## 构建打包

```bash
npm run build      # esbuild 打包渲染进程
npm run release    # 本地打包 NSIS 安装包
npm run release -- -Publish   # 打包并自动发布到 GitHub Releases（需 GH_TOKEN）
```

## 自动发布（GitHub Actions）

打 tag 后 CI 自动构建并发布：

```bash
git tag v0.1.40
git push origin v0.1.40
```

- **GitHub Releases**：Windows 安装包自动上传
- **GitHub Packages**：`@hwm-1114/markhunter` npm 包自动发布（私有）

## 冒烟测试

```bash
npm run smoke
```
