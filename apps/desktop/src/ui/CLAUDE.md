# `src/ui` 放置规则

目录地图见 `apps/desktop/AGENTS.md`。设计系统的视觉规则在 `.claude/rules/ui-design-system.md` 和 `docs/design-system.md`。

## 这个目录负责什么

工作台界面。原语、壳层和业务面板分开，避免一个目录里既有 Button 又有 Git 面板。

## 放置约束

- 设计系统原语放 `primitives/`。这里禁止引用 `src/services/` 里的业务 Service，也禁止引用 `note-list/`、`folders/`、`panels/`、`git/`、`chat/`、`overlays/`、`settings/`。`preview.service.ts` 只服务组件画布的预览层，留在 `primitives/`，不要把业务状态塞进去。
- 壳层放 `shell/`，业务面板放各自的功能目录，设置放 `settings/`。
- 面板的私有状态不要写进原语。跨面板共享的状态放进对应 Service。
- 颜色只用 `tokens.css` 的 `--sd-*`。`tokens.css` 保持单文件。
- `primitives.css`、`shell.css`、`panels.css`、`overlays.css` 只保留 `@import`。新规则写进该入口已经引入的分片；分片和组件放在同一功能目录。
- 样式与组件放在同一目录。`src/styles/` 只保留全局基础（`base.css`：reset、滚动条、裸 `input` / `textarea`）和栏布局网格（`layout.css`）。不要把组件规则写回 `src/styles/`。

## 开发偏好

视觉、组件 API 和图标规则在 `.claude/rules/ui-design-system.md`。本文件只写文件放在哪个目录。
