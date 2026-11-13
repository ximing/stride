# 桌面端助手 shell

> 状态：现行实现（Electron）
> 日期：2026-11-13
> 范围：`apps/desktop/electron/shell.ts`、`packages/electron-api`、`packages/shell-electron`、`apps/desktop/src/services/platform/shell.ts`、`apps/desktop/src/services/chat/chat-vault-host.ts`、`packages/platform` 的 `ShellBackend`

早期桌面壳曾按 Rust 宿主自建进程执行来设计。那条方案已被 Electron 主进程替代。本文只描述现在的进程、IPC 和打码边界，不再引用已删除的宿主 API 或文件。

## 1. 调用链

助手的 `bash` 工具仍在渲染进程。`packages/core` 的 `vault-tools` 经 `VaultToolHost.shell.exec` 交给宿主。桌面端真正拉起进程的是 Electron 主进程。

```text
vault-tools bash
  → chatVaultHost                         apps/desktop/src/services/chat/chat-vault-host.ts
    → resolveShellBackend()               apps/desktop/src/services/platform/shell.ts
      → shellBackend()                    packages/shell-electron
        → spawnShell / cancelShell        packages/electron-api
          → shell:spawn / shell:cancel    白名单 IPC
            → registerHostShell            apps/desktop/electron/shell.ts
```

浏览器走 `browserShellBackend()`，返回 `unavailableShell()`。`chatVaultHost` 在 `available === false` 时抛出 `Shell is not available in the browser`。

## 2. 职责

| 层 | 负责 | 不负责 |
|---|---|---|
| `apps/desktop/electron/shell.ts` | 受控解释器、session、进程组、login PATH、流式输出、timeout / cancel / cap、发送方销毁与退出回收 | cwd 从哪来、密钥打码、确认 UI |
| `packages/electron-api` | `shell:spawn`、`shell:cancel`、`shell:event` 的类型与白名单通道 | 进程和策略 |
| `packages/shell-electron` | 渲染进程 `ShellBackend`：先订阅事件再 spawn，把 exit reason 映射成 `ShellOutput` / `ShellAbortError` / `ShellTimeoutError`，执行前走 `ShellReviewer` | 选解释器、改环境 |
| `chat-vault-host` | 要求已打开 vault；`cwd` 固定为 `vault.fs.rootLabel`；对 stdout / stderr 以及 abort / timeout 附带的输出做 secret redaction | 拉起或杀死进程 |

`apps/desktop/electron/main.ts` 在启动时 `registerHostShell`，在 `before-quit` 时 `disposeAllShellSessions`。窗口销毁走 `disposeShellSender`，不再向已销毁的文档发结束事件。

## 3. 主进程

`registerHostShell` 只登记 `shell:spawn` 和 `shell:cancel`。每个 handler 先 `assertTrustedSender`。

一次 spawn：

1. 校验 `command`（非空、不超过 256KB）、绝对且存在的目录 `cwd`、可选的有限非负 `timeoutMs`。同时最多 8 个 session。
2. 解释器按 `bash`、`zsh`、`sh`（Windows 为对应 `.exe`）在 PATH 与固定 Unix 目录里找第一个可执行文件。用户命令固定为 `[interpreter, '-c', command]`，`shell: false`，stdin 为 `ignore`。
3. 新建 session，先发 `{ event: 'started', id }`。login PATH 用另一组解释器（`zsh`、`bash`、`sh`）跑 `-lic`，脚本打印哨兵 `__STRIDE_PATH__`。探测输出不进渲染进程。成功结果按解释器路径缓存；探测失败则用户命令继承主进程环境。
4. `commandEnvironment` 只保留一个 PATH 键：Windows 用 `Path`，POSIX 用 `PATH`。探测到的 PATH 覆盖它，其余父环境保留。
5. POSIX 上 `detached: true`，停止时 `kill(-pid, SIGKILL)`，失败再杀正 pid。Windows 用 `taskkill /T /F`。login 探测进程和用户进程各自成组，取消或回收时一起杀掉。

输出按块经 `shell:event` 推送，单条事件不超过 8KB。累计 stdout 与 stderr 达到 1MB 时以 `reason: 'cap'` 停进程，并带 `truncated: true`。超时、取消、封顶的优先级是 cancel > timeout > cap > exit。杀进程后若迟迟不 `close`，2 秒后以 `code: null` 结束 session。

`shell:cancel` 只接受本发送方拥有的 session id。

## 4. 渲染侧 IPC

`ELECTRON_REQUEST_CHANNELS` 包含 `shell:spawn` 和 `shell:cancel`。`ELECTRON_EVENT_CHANNELS` 包含 `shell:event`。渲染进程不能传解释器、参数数组或环境。

`spawnShell` 的请求体是 `{ command, cwd, timeoutMs? }`。`timeoutMs` 由 `shell-electron` 用 `timeoutSeconds * 1000` 换算，不取整。事件为 `started`、`stdout`、`stderr`、`error`、`exit`。`exit.reason` 为 `exit`、`cap`、`timeout` 或 `cancel`。

`shell-electron` 在 `invoke` 之前订阅 `shell:event`，避免 `started` 先到。原始块按收到的顺序拼接。`cap` 时若 stderr 还没有 `[output truncated]`，再补上这一行。`ShellDeniedError` 来自 reviewer，不经过主进程。默认 reviewer 放行；桌面装配使用 `desktopShellReviewer`。

## 5. 工作目录与打码

`chatVaultHost` 在没有 `vault.fs` 时拒绝执行（`Open a vault first`）。通过的命令把 `cwd` 设为 `vault.fs.rootLabel`。

返回前用已配置密钥做 `redactSecret`，长密钥优先。`ShellAbortError` 和 `ShellTimeoutError` 打码后仍是原来的类，`seconds` 不变。其他错误原样抛出。密钥不进入主进程的 shell 模块，也不写入 vault。

## 6. 刻意不做

- 不解析 shell 语法去拦笔记文件。提示词要求用笔记工具改 `*.stride.json`，执行层不检查。
- 不做 chroot、Seatbelt、容器或伪终端，也不做命令输出的实时终端面板。
- 不把强力模式写进主进程。`bash` 是否挂上仍由工具列表和 agent 模式决定。
- 浏览器不提供假 shell。
