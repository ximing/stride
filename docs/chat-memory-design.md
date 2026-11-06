# 助手会话持久化与记忆系统技术方案

> 状态：v2（2026-11-06，已并入独立审阅意见：修正 system 消息固化、vault-key 取值、appdata 实现路径、History 元信息、并发写等 7 处必须修正项与 10 处建议项）
> 范围：`apps/desktop`、`packages/core`、`packages/platform`、新增 `packages/appdata-tauri` / `packages/appdata-web`

## 1. 背景与目标

当前助手面板（`ChatService`）存在三个短板：

1. **会话不落盘**：`sessions` 只存在于内存，刷新/重启即丢失，无法回看历史。
2. **单轮对话**：`runAgentLoop` 每次只发一条 `prompt`，不携带历史消息；`ask()` 在已有消息的会话里会强制开新会话（`chat.service.ts:63-64`）。
3. **无长期记忆**：每次对话都是零状态，Agent 不记得用户偏好、过往决定与项目惯例。

本方案覆盖四块工作：

| 模块 | 目标 |
|---|---|
| A. 面板交互与样式 | 修复头部重叠、工具调用刷屏；补齐「关闭 / 终止 / 历史召回」操作 |
| B. 会话持久化 | 会话全量落盘（桌面 `~/.stride/`，浏览器 IndexedDB），History 召回并**继续多轮对话** |
| C. 记忆系统 | 两级索引的长期记忆，会话开始注入索引，Agent 按需读取/写回 |
| D. 记忆蒸馏与梳理 | 会话结束自动蒸馏 + 手动触发；定期清理冲突/过时/损坏记忆 |

已确认的前置决策：

- Web 端存储介质：**IndexedDB**。
- 蒸馏触发：**会话结束自动 + 手动命令**，不做每轮触发；应用退出只落 dirty 标记，启动时补跑（见 §6.1）。
- 记忆作用域：**项目级 + 全局级**两层，项目级优先。
- 蒸馏/梳理模型：**独立配置项**（可选，缺省跟随聊天默认模型）。

## 2. 术语与约束

- **会话（Session）**：一次连续对话，包含多条消息与一个模型 transcript。
- **Transcript**：`pi-agent-core` 的 `AgentMessage[]` 中 **role 为 user / assistant / toolResult 的部分**（**不含 system 消息**，原因见 §4.4），是「继续对话」的上下文来源。已验证 `AgentMessage` 为纯 JSON 可序列化结构（timestamp 为 number）。
- **UI 投影（messages）**：渲染用的精简结构（text / thinking / 工具调用摘要），由 transcript 派生但独立持久化，避免回放时才重建。
- **vault-key**：分项目目录名，基于 **`VaultService.activeVaultId`**（vault 注册表 id，`createVaultId()` 生成），**不是** rootLabel——fs-web 的 rootLabel 只是目录名字（`packages/fs-web/src/browser-fs.ts:91`），同名 vault 会撞 key。派生方式见 §3.5。
- 约束沿用根 CLAUDE.md：密钥不进 vault、不写入记忆；业务逻辑零 Node 依赖，I/O 全部走平台端口；**不在 src-tauri 写业务逻辑**（apps/desktop/CLAUDE.md），appdata 桌面端纯 JS 实现（见 §3.2）。

## 3. 存储层：`AppDataStore` 端口

### 3.1 端口定义（`packages/platform/src/appdata.ts`）

刻意窄接口，只覆盖「应用私有数据」的读写，不复用 `FileSystemBackend`（避免把 vault 语义带进应用数据）：

```ts
export interface AppDataStore {
  /** 读取逻辑路径内容；不存在返回 null。 */
  readText(path: string): Promise<string | null>
  /** 原子写入：先写 <path>.tmp 再 rename 覆盖。 */
  writeText(path: string, text: string): Promise<void>
  /** 追加一行（log.jsonl 用）。 */
  appendLine(path: string, line: string): Promise<void>
  /** 按前缀列出逻辑路径（相对根，POSIX 分隔符）；结果不含 *.tmp 残留。 */
  list(prefix: string): Promise<string[]>
  /** 删除；不存在不报错。 */
  remove(path: string): Promise<void>
}
```

逻辑路径统一形如 `chats/<vault-key>/<session-id>.json`，**禁止 `..` 与绝对路径**，两端适配器各自校验（复用 platform 已有的 `normalizeRelativePath`）。`list` 实现侧负责过滤崩溃残留的 `*.tmp`。

### 3.2 桌面实现（`packages/appdata-tauri`）

- **纯 JS 实现，不新增 Rust 命令**：复用 `@tauri-apps/plugin-fs`（与 `packages/fs-tauri/src/fs.ts` 同一机制），根目录 `${home}/.stride`。home 经现有 `HostPaths` 端口（`packages/platform/src/host.ts`，tauri 实现 `packages/fs-tauri/src/home.ts` 用 `@tauri-apps/api/path.homeDir()`）解析。
- capability 已放开 `fs:scope: **`（`capabilities/default.json:77-79`），**无需改权限配置**。
- 选址与现状一致：`~/.stride/settings.json` 已是既有应用数据文件（`settings.ts` `defaultSettingsPath`）。
- 写文件：`write(tmp) → rename`，崩溃最多损失最后一个 tmp 文件；路径白名单与 root 校验在 TS 层做（对齐 fs-tauri 的 `rejectSymlinks`/root 校验模式）。

### 3.3 Web 实现（`packages/appdata-web`）

- IndexedDB：db 名 `stride-appdata`，object store `files`，key 为逻辑路径字符串，`list(prefix)` 用 `IDBKeyRange.bound(prefix, prefix + '￿')`。
- 原子性：单条记录 put 本身即原子；`appendLine` 采用 read-modify-write 事务。
- **降级**：浏览器隐私模式 / IDB 不可用时降级为内存实现。注意 secrets-web **没有**此先例（IDB 不可用直接抛错，`secrets-web/src/store.ts:91`），这是新决策，因此必须配套**显式降级语义**（platform CLAUDE.md 要求）：面板给出「当前环境不持久化会话与记忆」的可见提示。

### 3.4 测试替身

`packages/platform` 提供 `MemoryAppDataStore`（Map 实现），供 core 单测与桌面组件测试使用，列入 `doubles.test.ts` 的契约测试，保证三端实现行为一致。

### 3.5 vault-key 计算

输入为 **`VaultService.activeVaultId`**（注册表 id，桌面按路径、Web 按 handle 同一性分配，见 `vault.service.ts` 的 `createVaultId`/`idFor`）。对 id 做 SHA-256 取前 16 位 hex：

```ts
// @stride/core —— 复用 packages/core/src/sha256.ts 的现有同步实现
//（该文件专为规避 WebCrypto digest 的 macrotask 时序问题而存在，禁止改用 crypto.subtle）
export function vaultStorageKey(vaultId: string): string {
  return sha256Hex(vaultId).slice(0, 16)
}
```

已知弱点（与注册表行为一致，可接受）：桌面端 vault 目录移动/改名后注册表会分配新 id，历史与记忆失联。

## 4. 会话持久化（模块 B）

### 4.1 存储格式

每会话两个文件：

**元信息 `chats/<vault-key>/<session-id>.meta.json`**（小文件，History 列表只读它）：

```jsonc
{
  "format": 1,
  "id": "ses_01JDQ8Z3…",
  "vaultKey": "9f2c1ab8e04d77c3",
  "vaultLabel": "work-notes",           // 仅展示用
  "title": "修复提交检查",
  "createdAt": "2026-11-06T08:00:00.000Z",
  "updatedAt": "2026-11-06T08:12:31.000Z",
  "status": "active",                   // active | closed（见 §4.3）
  "modelId": "cfg_zhipu_flash",         // 首轮回合后锁定（见 §4.4 跨模型约束）
  "messageCount": 6,
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "costTotal": 0 }
}
```

**正文 `chats/<vault-key>/<session-id>.json`**：

```jsonc
{
  "format": 1,
  "id": "ses_01JDQ8Z3…",

  // UI 投影：渲染消息列表直接用，不回放 transcript
  "messages": [
    {
      "id": "msg_…",
      "role": "user",
      "text": "提交检查拦住了这个仓库…",
      "ts": "2026-11-06T08:00:01.000Z"
    },
    {
      "id": "msg_…",
      "role": "assistant",
      "text": "我来修复…",
      "thinking": "…",
      "ts": "2026-11-06T08:00:05.000Z",
      "tools": [
        {
          "id": "call_…", "name": "read_note",
          "argsSummary": "{\"id\":\"agents/review/…\"}",
          "resultSummary": "…", "durationMs": 93,
          "isError": false, "pending": false
        }
      ]
    }
  ],

  // 模型 transcript：仅 user / assistant(含 toolCalls) / toolResult，
  // **绝不含 system 消息**（system 每轮重建，见 §4.4）
  "transcript": [ /* AgentMessage（去 system 后）… */ ],

  // 蒸馏游标（见 §6.1）
  "memory": {
    "distilledUpTo": 6,                  // transcript 前 N 条已蒸馏
    "lastDistillAt": "2026-11-06T08:15:00.000Z"
  }
}
```

设计要点：

- **拆分 meta/正文**的原因：History 列表按 `updatedAt` 倒序需要元信息，而正文含完整 transcript 可达 MB 级，`AppDataStore` 无「读前 N 字节」能力（IDB 也只能整值读出），故元信息独立成小文件。
- **双写 messages + transcript**：UI 投影保证面板打开即渲染；transcript 保证续聊上下文无损。两者在每轮结束时一起持久化。
- transcript 中的 toolResult 可能很大：写入前对单个 toolResult 内容超过 8KB 的部分截断并标注 `[truncated]`，防止会话文件无限膨胀（UI 投影里的 `resultSummary` 不受影响）。
- 写回前对全文执行机密扫描（见 §5.5 的检测语义），防止 key 经工具结果泄漏进磁盘。
- 读取时校验 `format` 与必填字段，损坏文件重命名为 `<id>.corrupt-<ts>` 并跳过，不阻塞面板。
- 持久化前必须**拷贝** `agent.state.messages`（其 getter 返回活数组引用，`pi-agent-core agent.js`），再剥离 system 消息。

### 4.2 会话索引（History 列表）

History 列表 = `list('chats/<vault-key>/')` 过滤 `*.meta.json` 后逐个读取（每个仅数百字节），按 `updatedAt` 倒序。会话数量级（几十到几百）下足够快；将来若成瓶颈再加聚合一级的 `index.json` 缓存，格式向前兼容。

### 4.3 生命周期与操作

```
        newSession()                 发送消息                close()
空白会话 ─────────→ active(空) ───────────→ active(对话中) ──────→ closed
                       ↑                        │                   │
                       │                        │ abort()           │ History 打开
                       ▼                        ▼                   ▼
                       └──────────── History 打开任意会话 ──── active(继续对话)
```

- **终止（Abort）**：仅当 `running = true` 可用。调 `AbortController`（现有 `abort()` 即此语义，`runAgentLoop` 对 abort 正常返回不抛错），已流式产出的文本/工具记录保留，assistant 消息尾部标注「已停止」；会话保持 active，可继续输入。
- **关闭（Close）**：`status → 'closed'`，立即保存，面板回到空白新会话。closed 会话仍在 History 中，可随时打开。
- **History 打开继续对话**：加载 meta + 正文 → 恢复 messages + transcript + modelId → 置为 active。再次发送时把 transcript 注入 `runAgentLoop`（见 §4.4），实现真正的多轮续聊。
- **删除（Delete）**：History 中彻底删除 meta + 正文；若删的是当前会话，回到空白会话。
- 空会话（无消息）不落盘。

### 4.4 多轮对话改造（`runAgentLoop`）

`pi-agent-core` 的 `Agent` 支持 `initialState.messages` 种子 transcript（已核实 `AgentInitialState = Partial<Omit<AgentState, …>>`，构造函数 slice 后使用），**但有一个必须绕开的坑**：

> `createMutableAgentState`（`agent.js:31-35`）只在种子 `messages[0]` **不是 system** 时才插入新构建的 systemPrompt；若种子带旧 system 消息，新 systemPrompt（含最新 vault 快照、记忆索引、工具声明）会被**静默丢弃**，旧快照永久固化。且 `agent.state.messages` 一定以 system 消息开头（system 内嵌当时的 tool declarations）。

因此规定：

- **持久化的 transcript 一律剥离全部 system 消息**，只存 user / assistant / toolResult；
- 续聊种子 = 持久化 transcript（无 system），`initialState.systemPrompt` 每轮重新构建（vault 快照 + 记忆索引），由 Agent 自动 unshift 为新的首条 system 消息；
- 发送前从 `agent.state.messages` 取回全量、拷贝、剥 system 后持久化。

改造签名：

```ts
// packages/core/src/agent-loop.ts
export async function runAgentLoop(input: {
  // …现有字段
  history?: AgentMessage[]   // 新增：不含 system 的历史 transcript
}): Promise<{
  // …现有字段（text/usage/aborted/turnLimit）
  transcript: AgentMessage[] // 新增：拷贝 + 去 system 后的完整 transcript（供持久化）
  error?: string             // 新增：provider 错误不再裸 throw（见下）
}>
```

- **错误路径也带 transcript**：现状 provider 错误直接 `throw`（`agent-loop.ts:162-164`），调用方拿不到任何 transcript，无法兑现「error 后也保存」。改为 resolve 返回 `{ error, transcript, … }`（或 throw 时在 Error 上挂 `transcript` 字段，二选一，前者更直白）。`commit-message.ts` 调用方同步适配。
- **跨模型续聊约束**：`modelId` 在首个助手回合完成后锁定进 meta；History 打开后若当前选择与锁定 modelId 不同，UI 提示并默认沿用锁定配置。跨 provider 回放（含 thinking signature 等 provider 专属字段的 AssistantMessage 喂给另一家）声明为**降级路径**：不阻塞，但不保证质量。
- `commit-message.ts` 不传 `history`，行为不变。

### 4.5 保存时机

| 时机 | 动作 |
|---|---|
| 每轮 `done` / abort / error 后 | 全量写 meta + 正文（atomic write）——**这是数据安全的真正保障** |
| 关闭会话 / History 切换 | 全量写 |
| 应用退出 | best-effort：仅落 dirty 标记（供启动时补跑蒸馏，见 §6.1）；**不依赖** `beforeunload`/close 事件里的写入成功（web 端 unload 内新发起的 IDB 事务不保证 commit） |
| 空闲 10 分钟（web 兜底） | 触发一次保存 + 蒸馏检查 |

## 5. 记忆系统（模块 C）

### 5.1 目录布局

```
~/.stride/                              # Web 端为 IndexedDB 中的同名逻辑路径
└── memory/
    ├── _global/                        # 全局层：跨项目偏好（语言、回复风格…）
    │   ├── index.json
    │   ├── entries/<entry-id>.json
    │   └── log.jsonl
    └── <vault-key>/                    # 项目层（vault-key 见 §3.5）
        ├── index.json
        ├── entries/<entry-id>.json
        └── log.jsonl
```

### 5.2 索引格式（`index.json`，二级索引第一级）

```jsonc
{
  "format": 1,
  "updatedAt": "2026-11-06T09:00:00.000Z",
  "distillCount": 7,                     // 蒸馏累计次数，curation 触发用（见 §6.2）
  "entries": [
    {
      "id": "mem_01JDQ…",
      "kind": "preference",            // preference | fact | decision | context | correction
      "title": "回复语言偏好",
      "summary": "用户要求技术讨论用中文，代码标识符保持英文。",
      "tags": ["language"],
      "status": "active",              // active | archived
      "updatedAt": "2026-11-06T09:00:00.000Z",
      "sessionId": "ses_01JDQ8Z3…",
      "supersedes": []                  // 覆盖关系（见 §6.3）
    }
  ]
}
```

预算控制：全局索引注入上限 1KB、项目索引 2KB（超出时按 `updatedAt` 倒序截断，并在注入文本末尾注明「另有 N 条可用 `memory_read` 检索」）。

### 5.3 条目格式（`entries/<id>.json`，第二级）

```jsonc
{
  "format": 1,
  "id": "mem_01JDQ…",
  "kind": "decision",
  "title": "提交信息规范",
  "content": "本仓库提交信息使用英文 imperative 句式，不带 scope 前缀；由 commit-check 强制。",
  "tags": ["git", "convention"],
  "createdAt": "…",
  "updatedAt": "…",
  "source": { "sessionId": "ses_…", "noteIds": ["agents/review/…"] },
  "status": "active"
}
```

### 5.4 注入策略

`chatSystemPrompt()` 扩展为三段式（每轮重建，保证新鲜）：

```
<context snapshot>          // 现有 buildAgentContext
<memory index section>      // 新增：全局索引 + 项目索引（标题 + 一句话摘要）
<VAULT_ASSISTANT_PROMPT> + <VAULT_MEMORY_PROMPT>
```

`VAULT_MEMORY_PROMPT` 为 **`@stride/core` 中的英文静态常量**（与 `VAULT_ASSISTANT_PROMPT` 同模式，见 `vault-tools.ts:56-66`；prompt 不走 i18n——i18n 只管 UI 文案，避免两份真相源与模型行为随 UI 语言漂移）。要点：

- 你拥有一份长期记忆索引（见上），条目含 id 与摘要。
- 当某条记忆与当前任务相关且需要细节时，调用 `memory_read(id)`。
- 当你确认了一个值得长期保留的用户偏好、项目惯例或重要决定时，调用 `memory_write`；同主题更新旧条目（传其 id）而非新建。
- 项目级记忆与全局级冲突时以项目级为准。
- 绝不把 API key、令牌、密码等机密写入记忆。

### 5.5 Agent 工具（`@stride/core`，chat 模式挂载）

| 工具 | 入参 | 行为 |
|---|---|---|
| `memory_read` | `{ id, scope? }` | 读条目全文；scope 缺省按 项目→全局 顺序解析 id |
| `memory_write` | `{ id?, scope, kind, title, content, tags? }` | 有 id 覆盖（记录 `supersedes`），无 id 新建；同步更新 index |
| `memory_forget` | `{ id, scope?, reason }` | 条目置 archived 并从 index 移除；写 log |

工具实现走 `AppDataStore`，宿主（`chat-vault-host` 同层新增 `chatMemoryHost`）注入。

**机密检测**：现有 `redactSecret`（`llm.ts:439-442`）只是对单个 secret 做精确替换，无检测语义，且只扫 active key。需新写检测函数：对**所有已配置 key**（全部 `llmConfigs[].apiKey` + embedding key）做 `contains` 检查，命中即拒绝写入并返回错误。会话文件与记忆写回统一走该检测。

### 5.6 并发写控制

index.json 是 read-modify-write，存在两类并发风险：

1. **同渲染进程内**：聊天轮中 Agent 调 `memory_write` 与后台蒸馏/梳理在 await 点交错即丢更新。
2. **跨 tab / 跨窗口**：浏览器多 tab 或 Tauri 多窗口指向同一 vault，内存锁失效。

措施：

- `chatMemoryHost` 内建**串行写队列**：所有 memory 写操作（Agent 工具、蒸馏、梳理）进同一 Promise 链，写前重读 index 再合并，杜绝同进程交错；
- Web 端加 **Web Locks API**（`navigator.locks`，按 `stride-memory-<scope>` 命名）兜底跨 tab；桌面端 Tauri 多窗口场景声明为首版已知限制（窗口少、操作稀疏），靠 curation 兜底修复；
- 残余的 last-writer-wins 风险在 §6.3 由 curation 的合并规则兜底。

## 6. 记忆蒸馏与梳理（模块 D）

### 6.1 蒸馏（Distillation）

- **触发**（满足其一且 transcript 有未蒸馏增量，即 `transcript.length > memory.distilledUpTo`）：
  1. 会话结束：切换会话 / 切换 vault / 关闭会话；
  2. 手动：命令清单新增「立即整理记忆」（`appCommandManifest.json`，含快捷键）；
  3. 应用启动时补跑：上次退出时落了 dirty 标记的会话；
  4. Web 空闲 10 分钟兜底。
- **退出不落 LLM 工作**：蒸馏是一次完整 LLM 请求，`beforeunload`/close 事件里发起必然被浏览器或系统杀掉；退出时只写 dirty 标记（meta 里一个布尔位或独立文件），下次启动扫描补跑。
- **模型**：设置新增「记忆整理模型」（独立 LLM 配置，可选；`memoryModelId` 引用的配置被删除时 normalize 回退为 `''` = 跟随聊天默认模型；两者都不可用则跳过并静默记 log，不打扰用户）。
- **蒸馏输入过滤**：transcript 增量中剔除 abort 产生的尾部残缺 assistant 消息（`stopReason: 'aborted'`），被中止的半段推理不得进入长期记忆。
- **运行方式**：headless `runAgentLoop`（不带 vault 写工具，只挂 `memory_*` 工具），输入 = 过滤后的 transcript 增量 + 当前两层索引；蒸馏 prompt 要求：
  - 只提取可长期复用的偏好 / 事实 / 决定 / 纠正；闲聊、一次性任务上下文不记。
  - 同主题覆盖旧条目（`memory_write` 传旧 id）。
  - 输出必须是工具调用，禁止自由文本。
- **并发与防抖**：同一 vault-key 同时只允许一个蒸馏任务（与 §5.6 的写队列配合）；触发时若已有任务在跑则标记 dirty，任务结束后补跑一次。运行状态在面板底部以一行小字展示（可取消）。
- **完成后**：更新会话文件的 `memory.distilledUpTo` 与 `lastDistillAt`，`index.distillCount += 1`。

### 6.2 梳理（Curation）

- **触发**：`distillCount` 每满 10，或项目条目数 > 100（全局层阈值 50）。
- **方式**：独立 headless 运行，输入 = 全量 index + 按需 `memory_read` 取正文，规则：
  - **冲突**：两条记忆对同一主题给出矛盾结论 → 保留 `updatedAt` 较新者，旧者 archived 并记录 `supersedes`。
  - **过时**：引用了已不存在的笔记 id / 文件，或明显被后续决定取代 → archived。
  - **损坏**：空内容、无法解析、重复 id → 修复或 archived。
  - **合并**：多条碎片描述同一事实 → 合并为一条，`supersedes` 记录来源。
- **可审计**：所有写/删操作逐行 append 到 `log.jsonl`（`{ ts, op, id, reason, actor: "distill"|"curate"|"agent"|"user" }`），不进 index。log 上限 1000 行，超出后轮转（重命名为 `log.1.jsonl` 新开，只保留一代）防止无界增长。

### 6.3 覆盖语义小结

- 覆盖的键是**条目 id**；蒸馏/Agent 通过 prompt 约束「同主题复用旧 id」，curation 负责兜底清理漏网的重复（含 §5.6 并发写残留的重复）。
- `archived` 条目物理保留在 `entries/`（便于审计与恢复），但不进 index、不注入上下文。
- **`distilledUpTo` 游标语义**：基于 transcript 条数；一旦未来引入 transcript 压缩（§7 的 `transformContext`），压缩即重置游标并强制全量重蒸馏，schema 注释中固化此约定。

## 7. 设置项新增

`AppSettings.agent` 扩展（`packages/core/src/settings.ts`，沿用现有 `readAgent`/`sealAll`/`publicSettings` 三处往返模式，非密钥字段原样透传）：

```ts
interface AgentSettings {
  maxTurns: number
  memoryEnabled: boolean        // 默认 true
  memoryModelId: string         // '' = 跟随聊天默认模型；引用的配置被删时 normalize 回退 ''
}
```

设置页新增「记忆」分区：开关 + 模型下拉（复用现有 LLM 配置列表）+ 记忆占用统计（条数、大小）+ 「清空本 vault 记忆」危险操作。i18n 中英文同步（仅 UI 文案，prompt 常量不走 i18n，见 §5.4）。

## 8. 面板 UI 变更（模块 A）

### 8.1 头部重构

现状：会话切换 tab 与标题重叠挤压。

新布局（单行，左→右）：

```
[≡ History] [当前会话标题(截断,点击重命名)]  [■ 终止(仅运行时)] [× 关闭] [＋ 新建]
```

- 标题超长省略号截断，tooltip 显示全名。
- 保留现有 `data-testid`（`chat-tabs`、`chat-new`、`chat-tool`、`chat-error` 等）；新增 `chat-history`、`chat-close`、`chat-stop`。
- History 打开历史会话且锁定 modelId 与当前选择不同时，头部给出提示条（见 §4.4）。

### 8.2 工具调用折叠

- 同一 assistant 消息内的连续工具调用聚合为一条摘要行：`⚙ 9 次工具调用 · 2 失败 · 展开`。
- 展开后每条单行紧凑显示：状态图标（成功灰 / 失败红 / 运行中转圈）+ 名称 + 耗时，点击再展开 args/result 详情（保留现有 `<details>` 行为与 `chat-tool` testid）。
- 失败摘要行整体标红，运行中摘要行带脉冲动画。

### 8.3 History 面板

- 头部 History 按钮打开 overlay（复用 search-panel 的 overlay 模式）：按 `updatedAt` 倒序，每行显示标题、相对时间、消息数、模型名；行内操作：打开 / 删除。
- 空历史显示 EmptyState。
- 打开历史会话后头部显示「继续对话」状态，输入框正常可用。

### 8.4 记忆状态

- 蒸馏/梳理运行中：面板底部一行 `正在整理记忆…（可取消）`。
- **降级提示**：Web 端 IndexedDB 不可用时，面板显示「当前环境不持久化会话与记忆」（见 §3.3）。
- 记忆命中：当助手本轮调用了 `memory_read`，在该消息的折叠工具区正常展示，不另做特殊 UI。

## 9. 测试策略

| 层 | 内容 |
|---|---|
| `packages/platform` | `MemoryAppDataStore` + 三端契约测试（doubles，含 tmp 过滤、前缀 list、append 行为） |
| `packages/core` | 会话文件 (反)序列化与损坏恢复、transcript 去 system 与 toolResult 截断、vault-key 计算（复用 `sha256.ts`）、index 读写与预算截断、机密 contains 检测、蒸馏/梳理 prompt 的输入组装（纯函数）、`runAgentLoop` 的 history 种子与 error 带 transcript |
| `apps/desktop` | ChatService：多轮续聊 mock loop 断言 history 传入且不含 system；关闭/终止/删除/召回状态机；meta/正文双写；History overlay；工具折叠渲染；设置项往返（含 memoryModelId 悬空回退）；memory host 写队列串行性 |
| E2E（后续） | Playwright：发消息→刷新→History 召回→续聊；蒸馏触发断言 index 更新 |

约束：所有新增/重构保留既有 `data-testid` 与 aria 语义（根约束 5）。

## 10. 兼容与迁移

- 全新功能，无历史数据迁移；所有新文件带 `format: 1`，读取侧一律走 normalize 函数（参照 settings 的 read/normalize 模式）。
- 现有单轮行为变更：`ask()` 不再强制开新会话，同一会话内自然多轮——这是对用户的显性行为变化，在 CHANGELOG/发版说明中标注。

## 11. 实施计划

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M1 | `AppDataStore` 端口 + tauri（纯 JS/plugin-fs）/web（IDB）适配器 + 内存替身 | — |
| M2 | `runAgentLoop` history/transcript/error 改造 + 会话文件 schema（core，含去 system 约定） | — |
| M3 | ChatService 持久化 + 多轮 + 关闭/终止/删除/召回；面板头部重构与工具折叠（A） | M1、M2 |
| M4 | 记忆存储层 + 写队列/Web Locks + index 注入 + `memory_*` 工具 + `VAULT_MEMORY_PROMPT` | M1 |
| M5 | 蒸馏/梳理 service（含 dirty 补跑、计数器、log 轮转）+ 设置项 + 命令 + 状态 UI | M3、M4 |

每个里程碑独立可交付、可测试；M3 完成后用户即可获得「持久化 + 历史续聊 + 新面板」，M4/M5 在此之上叠加记忆。

## 12. 已排除与后续触发条件（Out of Scope）

- **transcript 超长压缩（compaction）**：pi-agent-core 提供 `transformContext` 钩子（已验证存在，`agent.d.ts:10`）。启用触发条件：单会话累计 `usage.totalTokens` 超阈值（初定 200k）或 transcript 超 200 条时，用 `transformContext` 做摘要替换；启用时按 §6.3 重置蒸馏游标。背景：`maxTurns` 默认 200，每轮换发全量 transcript，长会话 token 成本超线性增长，此阀值化开关是成本控制阀。
- 记忆的向量检索：当前索引注入 + `memory_read` 足够；条目规模超阈值后再评估接入 `search-web`。
- 跨设备同步：`.stride` 目录不进 git；将来可经独立同步通道处理。
- 记忆的手动编辑 UI：首版只读（History 面板可看条数），编辑交给 Agent 工具。
- Tauri 多窗口写同一 vault 记忆的跨进程锁：首版已知限制（§5.6）。
