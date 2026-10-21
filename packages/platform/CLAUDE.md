# `@stride/platform` 端口契约说明

## 这个目录负责什么

`packages/platform` 定义 Stride 核心领域层与底层宿主环境（Tauri 桌面端 / 现代浏览器 / 测试环境）之间的**端口接口（Ports）与内存测试替身（Test Doubles）**：

- `fs.ts`：`FileSystemBackend` 接口与 `MemoryFileSystem` 内存实现
- `git.ts`：`GitBackend` 接口与测试替身
- `search.ts`：`SearchBackend` / `SearchBackendOpener` 接口与 `memorySearchOpener`
- `secrets.ts`：`SecretsStore` 接口与内存实现
- `updater.ts`：`UpdaterBackend` 接口
- `error.ts`：跨平台统一错误类型与错误码

同级的适配器包（`packages/fs-tauri`、`fs-web`、`git-tauri`、`git-web`、`search-web`、`secrets-tauri`、`secrets-web`）均以本包的接口为唯一契约。

## 放置约束

- **应该放这里**：
  - 平台无关的接口定义、数据结构契约、统一错误类型。
  - 供全仓单元测试复用的纯内存替身（In-Memory Doubles）。
- **不应该放这里**：
  - 任何绑定具体宿主的依赖（禁止引入 `@tauri-apps/*`、IndexedDB、OPFS、WASM 或 `node:*`）。
  - 具体业务逻辑（属于 `@stride/core`）。

## 开发偏好

1. **最小完备接口**：新增平台能力时，先在 `@stride/platform` 中定义最小正交接口并配套更新内存替身，再分别在 `*-tauri` 和 `*-web` 中实现。
2. **路径规范化**：端口层面的文件路径统一使用 POSIX 风格相对路径（以 `/` 分隔，不带前导 `/`），由各端适配器在边界处转换宿主路径。
3. **显式能力降级**：当某一端（如纯浏览器下的 Git）无法提供完整系统能力时，通过接口约定的状态或降级实现返回明确语义，而非抛出未捕获异常。
