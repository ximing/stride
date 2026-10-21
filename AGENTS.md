# Stride 架构地图

给进入仓库的 agent 用。行为约束在各级 `CLAUDE.md` 和 `.claude/rules/`。本文件只回答代码放在哪、谁可以依赖谁。

## 仓库

- `packages/core`：笔记、图谱、搜索编排、Git 状态、Agent 工具。纯 TypeScript，不碰宿主 API。
- `packages/platform`：文件系统、Git、搜索、密钥、更新的端口与内存替身。
- `packages/fs-*`、`git-*`、`search-web`、`secrets-*`：Tauri 与浏览器适配器。只实现端口，不写界面规则。
- `apps/desktop`：React 工作台，同时是 Tauri 宿主和纯浏览器入口。更细的目录地图在 `apps/desktop/AGENTS.md`。

## 依赖方向

`apps/desktop` → `@stride/core` 与 `@stride/platform` 端口 → 具体适配器。

领域算法留在 `packages/core`。桌面端 Service 只做状态编排和宿主装配。适配器不反向依赖 UI。

## 规则放在哪

- 根 `CLAUDE.md`：全仓库都要遵守的约束和常用命令。
- `apps/desktop/CLAUDE.md`、`packages/core/CLAUDE.md`、`packages/platform/CLAUDE.md`：子系统约束。
- `apps/desktop/src/{services,ui,editor}/CLAUDE.md`：进入该目录时的放置规则。
- `.claude/rules/*.md`：按 glob 命中的横切规则（Service、设计系统、测试、适配器）。
