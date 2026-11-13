---
paths:
  - "packages/platform/**/*.ts"
  - "packages/fs-*/**/*.ts"
  - "packages/git-*/**/*.ts"
  - "packages/shell-*/**/*.ts"
  - "packages/search-web/**/*.ts"
  - "packages/secrets-*/**/*.ts"
---

# 跨平台端口与适配器实现规则

## 契约先行

- 所有宿主能力必须先在 `@stride/platform` 中声明接口（`FileSystemBackend`、`GitBackend`、`ShellBackend`、`SearchBackend`、`SecretsStore`、`UpdaterBackend`、`HostPaths`），并在 `@stride/platform` 内提供配套的内存替身（Test Doubles）。
- `packages/*-electron` 与 `packages/*-web` 仅负责将宿主 API 适配到 `@stride/platform` 接口，不包含领域业务规则。

## Electron 端适配器（`*-electron`）

- 文件系统、Git 与 Shell 由 `packages/*-electron` 经 IPC 调用 Electron 主进程。这些包是 IPC 客户端，不引入 `node:fs` 或 `node:child_process`。Node I/O 只在主进程 `apps/desktop/electron/`。
- Shell 只放行 `bash`、`zsh`、`sh`。`cwd` 是调用方传入的绝对目录（`apps/desktop/electron/shell.ts` 的 `checkCwd`），通常是 vault 根，不是写死的仓库根。
- 严格校验并规范化路径，防止目录穿越。禁止在 Home / Desktop 等宽泛目录 `git init` 的检查留在 `@stride/core` 的 `isBroadPersonalRoot`（在 `GitBackend.init` 之前调用），不放进适配器。

## 浏览器端适配器（`*-web`）

- `fs-web`：基于 File System Access API，目录句柄持久化在 IndexedDB 中；启动恢复时需正确处理 `queryPermission` / `requestPermission` 授权流及浏览器不支持时的降级提示。
- `git-web`：在无系统 Git 能力的纯浏览器环境下提供显式降级语义，让上层 UI 能平滑展示“Git 不可用”而非崩溃。
- `search-web`：基于 `@vane-rs/web`（WASM），需保证索引生命周期（open / upsert / search / close）在 Webview 与浏览器中行为一致。
- `secrets-web` / `secrets-electron`：API Key 必须经加密封装（Keychain 或随机主密钥 AES seal）存储，掩码回显为 `••••xxxx`，严禁明文落盘到 Vault 目录。密钥密封只在主进程或浏览器存储里完成，不进渲染进程的业务模块。
