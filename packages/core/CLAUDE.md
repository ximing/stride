# `@stride/core` 领域内核说明

## 这个目录负责什么

`@stride/core` 是 Stride 的纯领域逻辑层，封装所有与 UI 框架和宿主环境无关的核心业务规则：

- **笔记模型与序列化**（`note.ts`、`types.ts`、`vault.ts`、`folders.ts`、`seed.ts`、`sample.ts`、`vault-config.ts`）：`*.stride.json` 解析与保存、H1 标题同步、Type 类型文档与模板、属性解析（`_` 前缀为隐藏系统属性）。
- **关系图谱与事务**（`graph.ts`、`rename-tx.ts`、`views.ts`）：`[[wikilink]]` 正文与属性关系提取、Backlinks 反链计算、Inbox 判定（无出站属性 wikilink）、crash-safe 笔记重命名与全库双链重写事务、Saved Views 过滤引擎。
- **搜索与排序**（`search.ts`、`search-rank.ts`、`embeddings.ts`）：基于 `SearchBackend` 的全量/增量索引编排、BM25 与 Embedding 向量 RRF 混合检索及失败自动降级。
- **Git 同步编排**（`git.ts`、`git-changes.ts`、`git-ahead.ts`、`git-surface.ts`、`sync-state.ts`）：Porcelain 状态解析、安全初始化检查（`roots.ts`，禁止在 Home/Desktop 等宽泛目录 init）、五态同步状态机（`idle`/`syncing`/`pull_required`/`conflict`/`error`）。
- **AI Agent 与 LLM**（`llm.ts`、`llm-catalog.ts`、`agent.ts`、`agent-loop.ts`、`vault-tools.ts`、`context-snapshot.ts`、`commit-message.ts`）：基于 `pi-agent-core`/`pi-ai` 的 Agent 循环、Safe/Power 权限分档工具集、上下文快照构建与 AI commit message 生成。

## 放置约束

- **应该放这里**：跨环境复用的纯领域模型、算法、状态机、端口编排逻辑及对应的单元测试（`*.test.ts`）。
- **不应该放这里**：
  - 严禁引入任何 `node:*` 模块（如 `node:fs`、`node:path`、`node:child_process`）。
  - 严禁引入 React、DOM API、`window`/`localStorage`、Tauri 插件（`@tauri-apps/*`）或浏览器专属 Web API（如 `showDirectoryPicker`）。
  - 具体平台实现必须放在 `packages/fs-*`、`packages/git-*`、`packages/search-web`、`packages/secrets-*`。

## 开发偏好

1. **依赖倒置**：所有文件系统、Git、搜索、密钥读写操作均通过函数参数或构造函数接收 `@stride/platform` 中的接口（如 `FileSystemBackend`、`GitBackend`、`SearchBackend`、`SecretsStore`）。
2. **结构化文档保护**：修改 `vault-tools.ts`（特别是 `write_note`、`append_to_note`）或 `rename-tx.ts` 时，必须操作 `TipTapNode` 树并保留未知节点/Mark 属性，切勿将正文退化为纯文本段落。
3. **Crash-safe 事务**：涉及跨多文件改写（如重命名改写双链）必须先写事务日志再执行变更，并确保 `recoverRename` 可幂等恢复。
4. **子路径导出同步**：公开给上层消费的核心模块需注意 `package.json` 的 `exports`（`.`、`./note`、`./graph`、`./git`）与 `src/index.ts` 的导出一致性。
