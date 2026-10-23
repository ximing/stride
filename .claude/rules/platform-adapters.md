---
paths:
  - "packages/platform/**/*.ts"
  - "packages/fs-*/**/*.ts"
  - "packages/git-*/**/*.ts"
  - "packages/search-web/**/*.ts"
  - "packages/secrets-*/**/*.ts"
---

# 跨平台端口与适配器实现规则

## 契约先行

- 所有宿主能力必须先在 `@stride/platform` 中声明接口（`FileSystemBackend`、`GitBackend`、`SearchBackend`、`SecretsStore`、`UpdaterBackend`、`HostPaths`），并在 `@stride/platform` 内提供配套的内存替身（Test Doubles）。
- `packages/*-tauri` 与 `packages/*-web` 仅负责将宿主 API 适配到 `@stride/platform` 接口，不包含领域业务规则。

## Tauri 端适配器（`*-tauri`）

- 文件系统与 Git 操作通过 Tauri 插件（plugin-fs / plugin-shell）与 Rust 端桥接。
- 严格校验并规范化路径，防止目录穿越；`git init` 等写操作必须遵守 `@stride/core` 的安全根目录限制（禁止在 Home / Desktop 等宽泛目录初始化）。

## 浏览器端适配器（`*-web`）

- `fs-web`：基于 File System Access API，目录句柄持久化在 IndexedDB 中；启动恢复时需正确处理 `queryPermission` / `requestPermission` 授权流及浏览器不支持时的降级提示。
- `git-web`：在无系统 Git 能力的纯浏览器环境下提供显式降级语义，让上层 UI 能平滑展示“Git 不可用”而非崩溃。
- `search-web`：基于 `@vane-rs/web`（WASM），需保证索引生命周期（open / upsert / search / close）在 Webview 与浏览器中行为一致。
- `secrets-web` / `secrets-tauri`：API Key 必须经加密封装（Keychain 或随机主密钥 AES seal）存储，掩码回显为 `••••xxxx`，严禁明文落盘到 Vault 目录。
