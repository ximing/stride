# `src/services` 地图

约束见同目录 `CLAUDE.md`。完整桌面地图见 `apps/desktop/AGENTS.md`。

按域放置：`vault/`、`notes/`、`layout/`、`views/`、`search/`、`commands/`、`git/`、`chat/`、`settings/`、`update/`、`appearance/`、`platform/`。

依赖只能指向 `@stride/core`、`@stride/platform`、适配器，以及同层 Service。不要指向 `src/ui` 或 `src/editor` 的生产代码。
