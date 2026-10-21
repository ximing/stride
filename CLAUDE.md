# Stride 项目指令

## 项目概览

- **定位**：Local-first、Git-first、AI-first 的富文本笔记工作台（桌面端 Tauri 2 + 浏览器端双模运行）。
- **核心模型**：文件夹即 Vault；每篇笔记在磁盘上存储为 `*.stride.json`（包含 `format`、`title`、`type`、`properties` 与 TipTap JSON `doc`）；无中心化数据库，文件系统是唯一真相源。
- **核心技术栈**：
  - 包管理与工作区：`pnpm` workspace（`apps/*`、`packages/*`）
  - 领域内核：`@stride/core`（纯 TypeScript，零 Node 专属依赖）
  - 端口与适配器：`@stride/platform` 定义接口，`fs-tauri`/`fs-web`、`git-tauri`/`git-web`、`search-web`（基于 `@vane-rs/web` WASM）、`secrets-tauri`/`secrets-web` 分别提供 Tauri 与浏览器实现
  - 前端应用：`apps/desktop`（React 19 + Vite + `@rabjs/react` 响应式 Service 状态管理 + TipTap 3 + Radix UI 原语 + `lucide-react`）
  - 内置 Agent：`@earendil-works/pi-agent-core` + `pi-ai`（BYOK 直连模型 API）

## 全局工程约束

1. **Webview / 浏览器自洽（零 Node Server）**：所有业务逻辑运行在前端上下文，严禁在 `@stride/core` 或 `apps/desktop/src` 中直接引入 `node:fs`、`node:child_process` 等 Node 内置模块；一切外部 I/O 必须通过 `@stride/platform` 端口注入。
2. **密钥与隐私隔离**：LLM / Embedding API Key 必须通过 `SecretsStore`（系统 Keychain 或 AES seal）加密保存在应用设置中，**绝不能**写入 Vault 目录内。
3. **不破坏笔记文档结构**：任何程序化改写笔记（尤其是 Agent 工具 `write_note`、重命名双链改写 `rename-tx`）必须基于 TipTap JSON 节点结构化操作，严禁将富文本文档压平为纯文本。
4. **命令与快捷键单一来源**：全局命令与快捷键统一在 `apps/desktop/src/appCommandManifest.json` 中声明，禁止在各组件内散落硬编码全局快捷键。
5. **保持测试锚点稳定**：重构 UI 或交互时，必须保留既有的 `data-testid` 属性与无障碍语义（`aria-label`、焦点管理）。

## 常用开发入口

- 安装依赖：`pnpm install`
- 启动纯浏览器开发模式（支持完整调试）：`pnpm dev`
- 启动 Tauri 桌面端开发模式：`pnpm tauri dev`
- 运行全仓单元测试：`pnpm test`
- 构建前端产物：`pnpm build`
- 运行桌面端 E2E 测试：`pnpm --filter @stride/desktop test:e2e`

## 局部规则与路径规则导航

架构地图（目录和依赖方向）在根 `AGENTS.md`，桌面端细分在 `apps/desktop/AGENTS.md`。

### 子系统级 `CLAUDE.md`（进入对应目录时按需加载）

- `packages/core/CLAUDE.md`：领域模型、笔记解析、双链图谱、重命名事务、搜索编排、Git 状态机与 Agent 工具集约束
- `packages/platform/CLAUDE.md`：平台端口契约与测试替身说明（同时指导 `packages/fs-*`、`git-*`、`search-web`、`secrets-*` 适配器边界）
- `apps/desktop/CLAUDE.md`：桌面/浏览器前端宿主架构、四栏布局、`@rabjs/react` Service 装配与调试通道
- `apps/desktop/src/services/CLAUDE.md`：Service 按业务域放置，以及和 UI、编辑器的依赖边界
- `apps/desktop/src/ui/CLAUDE.md`：原语、壳层、业务面板的放置边界和样式入口
- `apps/desktop/src/editor/CLAUDE.md`：TipTap 3 编辑器扩展、自定义节点序列化往返约束与编辑器内交互规范

### 横切路径规则 `.claude/rules/*.md`（按文件 glob 命中加载）

- `.claude/rules/ui-design-system.md`：设计系统 Token（`--sd-*`）、`sd-` 组件类前缀、Radix 原语封装与 `lucide-react` 图标规范
- `.claude/rules/rabjs-services.md`：`@rabjs/react` Service 状态管理、`observer`/`useService` 模式与命令清单同步约定
- `.claude/rules/platform-adapters.md`：跨平台端口与 Tauri/Web 适配器实现约束
- `.claude/rules/testing.md`：Vitest 单元测试、内存替身用法、序列化往返测试与 Playwright E2E 规范
- `.claude/rules/i18n.md`：桌面端中英文文案目录、`t()` / `commandTitle`，以及语言偏好不进 Vault
