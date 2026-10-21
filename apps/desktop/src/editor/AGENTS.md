# `src/editor` 地图

约束见同目录 `CLAUDE.md`。

根目录只放装配：`editor.tsx`、`extensions.ts`、`index.ts`（导出 `NoteEditor`）、`prompt.tsx`、`ime-enter.ts`、`roundtrip.test.ts`。`chrome.css` 只 `@import` `chrome/` 里的分片。

扩展按目录：`wikilink/`、`slash/`、`callout/`、`task/`、`table/`、`code/`、`math/`、`mermaid/`、`image/`、`paste/`、`find/`、`link/`、`menu/`、`toolbar/`。

可以依赖 `src/ui/primitives` 和 `src/services`。不要把 Vault 读写、图谱或全局搜索放进来，也不要在功能目录里再加 `index.ts`。
