# `src/ui` 地图

约束见同目录 `CLAUDE.md`。

- `primitives/`：设计系统原语。不依赖 `src/services/` 的业务 Service，也不依赖业务面板。`preview.service.ts` 只给组件画布做预览层。
- `shell/`：工作台壳层。
- `note-list/`、`folders/`、`panels/`、`git/`、`chat/`、`overlays/`、`views/`、`settings/`：各自的业务界面。
- `tokens.css`：全部 `--sd-*` 变量。
- `primitives.css`、`shell.css`、`panels.css`、`overlays.css`：只负责按顺序 `@import` 分片。

面板可以依赖原语。原语不能依赖面板。
