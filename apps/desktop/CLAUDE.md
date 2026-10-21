# `@stride/desktop` 桌面与浏览器应用说明

## 这个目录负责什么

`apps/desktop` 是 Stride 的前端工作台与 Tauri 宿主工程，同时支持**纯浏览器模式（`pnpm dev`）**与**Tauri 桌面应用模式（`pnpm tauri dev`）**：

- `src/main.tsx` & `src/app.tsx`：应用启动、主题同步初始化、`@rabjs/react` Service 容器注册、欢迎页（Chooser）与工作台主壳层挂载。
- `src/services/`：按业务域分目录的响应式服务（`vault/`、`notes/`、`layout/`、`views/`、`search/`、`commands/`、`git/`、`chat/`、`settings/`、`update/`、`appearance/`、`platform/`）。放置规则见 `src/services/CLAUDE.md`。
- `src/ui/`：原语在 `src/ui/primitives/`，壳层在 `src/ui/shell/`，列表、文件夹、右栏、Git、对话、浮层、设置各自一个目录。放置规则见 `src/ui/CLAUDE.md`。
- `src/editor/`：TipTap 3 编辑器。根目录只留装配，扩展在 `wikilink/`、`table/`、`math/` 等子目录。详见 `src/editor/CLAUDE.md`。
- `src/styles.css` 与 `src/styles/`：应用壳层样式。入口文件只做 `@import`。
- `src/dev/`：组件预览画布（访问 `/dev/components` 渲染）。
- `inspect/` & `src/inspect-*.ts`：供自动化与调试代理使用的页面检查与操控通道。
- `e2e/`：Playwright 浏览器端到端测试。
- `src-tauri/`：Tauri 2 Rust 宿主配置、权限声明（`capabilities/`）、打包图标与插件初始化。

目录和依赖方向的地图在 `AGENTS.md`。

## 放置约束

- **应该放这里**：
  - 视图组件、样式表（`*.css`）、编辑器扩展、前端状态编排 Service、宿主环境探测与适配器装配。
- **不应该放这里**：
  - 纯粹的领域算法与数据格式解析（如双链图计算、笔记 JSON 迁移、重命名事务、Git porcelain 解析）应下沉到 `packages/core`，保持可独立单测。
  - 在 `src/ui/primitives/` 中不要耦合具体某个业务面板的私有状态，也不要引用 `src/services/` 里的业务 Service。

## 开发偏好

1. **双模运行兼容**：任何新增功能必须考虑 Tauri 与纯浏览器双环境。调用 `@tauri-apps/*` API 前需确认环境可用或提供浏览器端回退（参考 `services/vault/vault.service.ts`、`services/platform/deep-link.ts`、`services/update/update-check.ts`）。
2. **命令驱动交互**：新增全局可触发操作或快捷键时，先在 `src/appCommandManifest.json` 注册，再由 `services/commands/command.service.ts` 与 `services/commands/commands.ts` 绑定实现，并确保通过 `services/commands/command-matrix.test.ts`。
3. **遵循设计系统**：UI 修改必须使用 `src/ui/tokens.css` 中的 `--sd-*` 语义变量和 `src/ui/primitives/` 下的封装组件，严禁硬编码色值或调用原生 `window.alert/confirm/prompt`。样式入口文件只保留 `@import`。
4. **保持四栏布局契约**：右侧面板（属性、TOC、Git、Chat）互斥切换，当前面板记在 `VaultService.panel`。栏宽和折叠由 `services/layout/layout.service.ts` 的 `LayoutService` 管。Git、Chat、Settings、Update 各自一个 Service，不要再合成一个文件。
