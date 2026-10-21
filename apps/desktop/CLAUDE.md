# `@stride/desktop` 桌面与浏览器应用说明

## 这个目录负责什么

`apps/desktop` 是 Stride 的前端工作台与 Tauri 宿主工程，同时支持**纯浏览器模式（`pnpm dev`）**与**Tauri 桌面应用模式（`pnpm tauri dev`）**：

- `src/main.tsx` & `src/app.tsx`：应用启动、主题同步初始化、`@rabjs/react` Service 容器注册、欢迎页（Chooser）与工作台主壳层挂载。
- `src/services/`：基于 `@rabjs/react` 的响应式业务服务层（Vault、NoteList、Tabs、Layout、Command、SearchPanel、Git、Chat、Settings、Update 等），连接 `@stride/core` 与平台适配器。
- `src/ui/`：四栏工作台界面（Sidebar、NoteList、RightPanel、TopBar、StatusBar）、设置中心（`src/ui/settings/`）及基础设计系统组件（Button、Input、Select、Tabs、Modal、Menu、Toast、Tooltip）。
- `src/editor/`：基于 TipTap 3 的富文本编辑器及自定义扩展（详见 `src/editor/CLAUDE.md`）。
- `src/dev/`：组件预览画布（访问 `/dev/components` 渲染）。
- `inspect/` & `src/inspect-*.ts`：供自动化与调试代理使用的页面检查与操控通道。
- `e2e/`：Playwright 浏览器端到端测试。
- `src-tauri/`：Tauri 2 Rust 宿主配置、权限声明（`capabilities/`）、打包图标与插件初始化。

## 放置约束

- **应该放这里**：
  - 视图组件、样式表（`*.css`）、编辑器扩展、前端状态编排 Service、宿主环境探测与适配器装配。
- **不应该放这里**：
  - 纯粹的领域算法与数据格式解析（如双链图计算、笔记 JSON 迁移、重命名事务、Git porcelain 解析）应下沉到 `packages/core`，保持可独立单测。
  - 在 `src/ui/` 基础原语中不要耦合具体某个业务面板的私有状态。

## 开发偏好

1. **双模运行兼容**：任何新增功能必须考虑 Tauri 与纯浏览器双环境。调用 `@tauri-apps/*` API 前需确认环境可用或提供浏览器端回退（参考 `vault.service.ts`、`deep-link.ts`、`update-check.ts`）。
2. **命令驱动交互**：新增全局可触发操作或快捷键时，先在 `src/appCommandManifest.json` 注册，再由 `command.service.ts` / `commands.ts` 绑定实现，并确保通过 `src/services/command-matrix.test.ts`。
3. **遵循设计系统**：UI 修改必须使用 `src/ui/tokens.css` 中的 `--sd-*` 语义变量和 `src/ui/` 下的封装组件，严禁硬编码色值或调用原生 `window.alert/confirm/prompt`。
4. **保持四栏布局契约**：右侧面板（属性、TOC、Git、Chat）采用互斥切换模式，通过 `LayoutService` 与 `PanelsService` 协调宽度与折叠状态。
