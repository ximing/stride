---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "apps/desktop/e2e/**/*.ts"
---

# 测试编写与验证规范

## 单元测试（Vitest）

- **就近放置**：单元测试文件与被测源码同目录，命名为 `*.test.ts` 或 `*.test.tsx`。
- **优先使用内存替身**：测试 `@stride/core` 或 `apps/desktop/src/services` 时，优先注入 `@stride/platform` 提供的 `MemoryFileSystem`、`memorySearchOpener` 及内存 `SecretsStore`，避免依赖真实文件系统或外部网络。
- **Service 测试隔离**：在组件或 Service 测试中，按需注册被测 `@rabjs/react` Service 并重置初始状态，避免跨用例污染。

## 专项契约测试

- **编辑器序列化往返测试**（`apps/desktop/src/editor/roundtrip.test.ts`）：凡新增或修改 TipTap 节点/Mark，必须补充或更新往返测试（含 `fast-check` 属性测试），确保 `TipTap JSON -> 文件序列化 -> 重新解析` 零丢失。
- **命令与快捷键矩阵审计**（`apps/desktop/src/services/commands/command-matrix.test.ts`）：凡涉及 `appCommandManifest.json`、快捷键或弹层互斥逻辑的修改，必须运行并通过该矩阵测试。

## 端到端测试（Playwright）

- E2E 测试位于 `apps/desktop/e2e/`，在纯浏览器模式下验证核心用户旅程（打开/新建 Vault -> 创建与编辑笔记 -> 搜索 -> 无控制台错误）。
- 定位元素时优先使用稳定的 `data-testid` 或语义化无障碍角色（Role / Label），不要依赖脆弱的样式类名层级。
