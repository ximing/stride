# `src/services` 放置规则

目录地图见 `apps/desktop/AGENTS.md`。这里只写在这个目录里改代码时的约束。

## 这个目录负责什么

`@rabjs/react` 的响应式 Service：把 `@stride/core` 和平台端口编排成界面状态。一个业务域一个子目录，测试与被测文件放在一起。

## 放置约束

- 新的全局 Service 放进已有的域目录；只有当它不属于任何一个域时才新建目录。
- 不要在 `services/` 根上再堆文件，也不要加桶文件 `index.ts`。调用方直接引用具体文件。
- 生产代码不引入 `src/ui` 或 `src/editor`。测试可以渲染对应面板。
- 跨 Service 只用 `resolve()` / `has()`。不要让 Git、Chat、Settings、Update 再写回同一个文件。
- `VaultService` 的字段是一份状态，不要把类拆成多个对象。纯函数可以留在 `vault/` 内的相邻文件。
- 领域算法（图谱、序列化、Git porcelain、重命名事务）放进 `@stride/core`，不要在 Service 里重写。

## 开发偏好

`raw()`、`register`、`observer` / `useService`，以及命令清单怎么和实现保持同步，见 `.claude/rules/rabjs-services.md`。
