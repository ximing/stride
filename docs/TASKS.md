# Stride Task 清单

> 对应 `docs/FEATURES.md`。原则：**先把"Chrome 里可全功能调试"的基座打牢，再逐模块补齐功能**。
> 每个任务给出：依赖、产出、验收标准。Phase 内可并行，Phase 间有先后。

## 关键架构决策（开发前确认）

**AD-1：业务逻辑全部跑在 webview，废弃 Node server 路线。**
现状是"前端 → HTTP → Node server(1421)"，导致 Tauri 打包后没有后端。改为：
- `packages/core` 浏览器化：所有 `node:fs`/`child_process` 依赖抽象为端口（`FileSystemBackend` / `GitBackend` / `SearchBackend` / `SecretsStore`），core 只依赖接口。
- Tauri 环境：TauriFS（plugin-fs）+ ShellGit（plugin-shell 调系统 git）+ KeychainSecrets。
- Chrome 环境：BrowserFS（File System Access API + IndexedDB 句柄持久化）+ IsoGit（isomorphic-git，或降级禁用）+ LocalSecrets（AES seal）。
- 搜索统一走 **vane WASM（`@vane-rs/web`）**：BM25 不需要任何外部服务；embedding 是前端直连 OpenAI 兼容 HTTP 接口。规避了 vane CLI 不支持 Windows 的问题，也没有 sidecar 生命周期管理。
- 现有 `server/desk.ts` 的逻辑（git/updater/agent 编排细节）迁移进 core，server 目录退役。
- LLM 调用直连：webview → provider HTTPS（CORS 由 Tauri webview 自定义协议规避；Chrome dev 用 vite proxy 规避）。

**AD-2：升级用 tauri-plugin-updater + 静态 latest.json**（比现状自实现的进程 handoff 更稳，与 tolaria 一致）。

**AD-3：UI 不引入重型组件库**，CSS 变量 + 少量 Radix 原语 + Phosphor 图标，参考 tolaria 的 Bear 风四栏。

---

## Phase 0 — 架构基座与 Chrome 调试（最先做，全部 P0）

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T0.1 ✅ 2026-10-13 | 定义端口接口：`FileSystemBackend`（read/write/list/mkdir/rename/delete/stat/watch）、`GitBackend`、`SearchBackend`、`SecretsStore`、`UpdaterBackend` | — | 接口 + 类型包 `@stride/platform` 建立 |
| T0.2 ✅ 2026-10-13 | core 浏览器化改造：note/vault/graph/git/settings/agent/updater 全部改为依赖注入端口，移除 `node:*` 顶层引用。临时包 `@stride/platform-node` 只给遗留 `server/` 注入，T8.5 随 server 删除 | T0.1 | `vitest`（jsdom 环境）全绿；`vite build` 不引入 node polyfill |
| T0.3 ✅ 2026-10-13 | BrowserFS：File System Access API 实现；目录句柄存 IndexedDB，启动时恢复授权（`queryPermission/requestPermission`）；不支持时优雅提示 | T0.1 | Chrome 中选目录后能列出/读写文件 |
| T0.4 ✅ 2026-10-13 | TauriFS：plugin-fs 实现同一接口 | T0.1 | `pnpm tauri dev` 中读写 vault 正常 |
| T0.5 ✅ 2026-10-13 | SearchBackend：接入 `@vane-rs/web`（WASM + OPFS/IDB 持久化），upsert/search/close；BM25-only 跑通 | T0.1 | 浏览器中建索引 + 搜索返回 snippet |
| T0.6 ✅ 2026-10-13 | GitBackend：Tauri shell 实现（init/status/diff/commit/pull/push/remote/clone/resolve，迁移现有 `git.ts` 逻辑）；Browser 降级实现（git UI 显示不可用） | T0.1 | Tauri 下 git 全套单测通过（mock shell） |
| T0.7 ✅ 2026-10-13 | SecretsStore：Tauri keychain + 浏览器 AES seal（修复硬编码密钥问题：用机器随机密钥存 keychain/IDB） | T0.1 | key 写入/读取/掩码回显 |
| T0.8 ✅ 2026-10-13 | Chrome dev 全链路：`pnpm dev` 纯浏览器跑通 打开vault→新建笔记→编辑保存→BM25 搜索 | T0.2-0.6 | 手工走查 + `/csi` 驱动验证 |
| T0.9 ✅ 2026-10-13 | 设计系统基座：CSS 变量（light/dark）、基础组件（Button/Input/Menu/Modal/Tooltip/Toast/Popover）、Phosphor 图标、四栏布局骨架 | — | Storybook 或 `/dev/components` 预览页 |
| T0.10 ✅ 2026-10-13 | inspect daemon 适配 Chrome（保留现有实现，确认在浏览器模式可用）+ Playwright 浏览器 e2e 骨架 | T0.8 | 一条 e2e：开库→建笔记→断言无 console error |

## Phase 1 — Vault 与笔记模型

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T1.1 ✅ 2026-10-13 | Vault 打开/新建流程：系统目录选择器（Tauri dialog / Browser showDirectoryPicker）、`.stride/vault.json` 标记、种子类型文档 | T0.3/0.4 | 新建 vault 后侧边栏出现默认类型 |
| T1.2 ✅ 2026-10-13 | vault 注册表（浏览器 localStorage `stride:vaults` + IndexedDB 句柄；Tauri 用目录路径作 label）+ 启动恢复上次 vault + 状态栏切换器 | T1.1 | 重启恢复现场 |
| T1.3 ✅ 2026-10-13 | Onboarding 欢迎页（新建/打开/克隆示例三选一） | T1.1 | 首次启动进入欢迎页 |
| T1.4 ✅ 2026-10-13 | 笔记模型完善：H1 即标题、写 H1 自动重命名文件（可关）、`untitled-*` 命名 | T0.2 | 单测 + UI 验证 |
| T1.5 ✅ 2026-10-13 | Type 系统 UI：侧边栏类型分组（icon/color/折叠/可见性）、类型文档 Instances 列表、新建笔记应用 template | T1.4 | 建类型 → 建实例 → 分组正确 |
| T1.6 ✅ 2026-10-13 | 属性面板：properties 编辑（string/number/bool/list）、`_` 系统属性隐藏、wikilink 值识别为关系 | T1.4 | 属性编辑即时保存 |
| T1.7 ✅ 2026-10-13 | Backlinks/关系/Inspector 右侧面板 | T1.6 | 双链互相可见、点击导航 |
| T1.8 ✅ 2026-10-13 | Inbox 视图 + 整理后自动前进 | T1.7 | 无出链笔记进入 Inbox |
| T1.9 ✅ 2026-10-13 | 重命名全局改写 wikilink（crash-safe 事务目录） | T1.7 | 重命名后所有引用更新；中途 kill 可恢复 |
| T1.10 ✅ 2026-10-13 | 文件夹树：内联 CRUD + 拖拽移动 | T1.1 | 拖拽移动后路径更新、链接不丢 |
| T1.11 ✅ 2026-10-13 | Archive/删除（永久）+ 确认弹窗 | T1.4 | archived 默认隐藏 |

## Phase 2 — 编辑器完备（TipTap）

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T2.1 ✅ 2026-10-14 | 编辑器重构：固定工具栏 + 选中文本气泡菜单（粗斜体/标题/列表/引用/链接/高亮） | T0.9 | 全按钮可用 + 快捷键 |
| T2.2 ✅ 2026-10-14 | Slash 菜单：`/` 插入块（标题/列表/表格/代码/图片/任务/分隔线/callout） | T2.1 | 键盘上下选择 + 过滤 |
| T2.3 ✅ 2026-10-14 | Wikilink 自动补全：`[[` 弹出笔记模糊搜索（接 vault 索引），未匹配项可直接创建 | T1.4 | 输入过滤、回车插入、点击导航、未解析点击创建 |
| T2.4 ✅ 2026-10-14 | 任务列表 TaskList/TaskItem + 列表完成度显示 | T2.1 | 勾选状态落盘 |
| T2.5 ✅ 2026-10-14 | 表格扩展（行列操作 UI） | T2.2 | 插入 3x3 表格并编辑 |
| T2.6 ✅ 2026-10-14 | 图片/附件：粘贴拖拽存 `attachments/`、lightbox、远程图片本地化 | T2.2 | 粘贴图片落盘并显示 |
| T2.7 ✅ 2026-10-14 | Callout / 高亮 mark | T2.2 | 渲染 + 序列化往返无损 |
| T2.8 ✅ 2026-10-14 | 代码块强化（常用语言高亮 + 复制按钮） | T2.2 | 高亮不卡输入 |
| T2.9 ✅ 2026-10-14 | 自动保存强化：防抖 + 保存状态指示 + 失败重试保留缓冲区 | T0.2 | 断网/写失败不丢内容 |
| T2.10 ✅ 2026-10-14 | TOC 大纲面板（与属性面板互斥切换） | T1.7 | H1-H3 树点击跳转 |
| T2.11 ✅ 2026-10-14 | 序列化往返测试：TipTap JSON → 文件 → 重新加载 零丢失（含所有自定义节点） | 全部编辑器任务 | property-based 测试 |

## Phase 3 — 搜索

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T3.1 ✅ 2026-10-14 | 搜索面板（Cmd+Shift+F）：结果列表 + snippet 高亮 + 跳转定位 | T0.5 | BM25 搜索中文笔记命中正确 |
| T3.2 ✅ 2026-10-14 | 增量索引：保存/删除/重命名 upsert；开库全量重建带进度 | T0.5 | 编辑后立即可搜到 |
| T3.3 ✅ 2026-10-14 | 列表内联过滤（标题/属性） | T1.5 | 输入即过滤 |
| T3.4 ✅ 2026-10-14 | 快速打开（Cmd+P 模糊标题搜索） | T1.4 | 键盘全流程 |
| T3.5 ✅ 2026-10-14 | Embedding 设置 + hybrid：endpoint/model/key/dim 配置、测试连接、query 向量生成、RRF 融合、失败降级 BM25（UI 显示降级状态） | T0.5, T0.7, Phase 9 设置页可先用临时 UI | 填 key 后 hybrid 生效；拔 key 自动降级 |
| T3.6 ✅ 2026-10-14 | 编辑器内查找替换（Cmd+F） | T2.1 | 查找/替换/全部替换 |

## Phase 4 — Agent

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T4.1 ✅ 2026-10-14 | LLM 配置层：provider 目录（openai-completions / anthropic）、多配置 + 默认、key 加密存储（参考 inwit `llm/pi.ts`） | T0.7 | 配置 → 连通性测试通过 |
| T4.2 ✅ 2026-10-14 | Agent 内核：pi-agent-core 封装（参考 inwit `run-agent-job.ts`）：maxTurns、abort、事件订阅、token 用量记录 | T4.1 | 单测 mock streamFn 跑通 loop |
| T4.3 ✅ 2026-10-14 | Vault 工具集：read_note/read_active_note/search_vault(走 vane)/create_note/append_to_note/list_notes/get_backlinks；write_note 结构化合并不压平文档（修复现版缺陷）+ 写前快照可撤销 | T4.2, T0.5 | 工具单测 + write 往返测试 |
| T4.4 ✅ 2026-10-14 | 流式对话 UI：text/thinking delta 流式渲染、Markdown 渲染、可中断、多会话 tab | T4.2 | 打字机效果 + abort 生效 |
| T4.5 ✅ 2026-10-14 | 工具调用卡片：名称/参数摘要/结果摘要/耗时/错误态；思考块折叠 | T4.4 | 卡片与 inwit 体验对齐 |
| T4.6 ✅ 2026-10-14 | 上下文快照：activeNote + openTabs + vault 概览结构化注入 system/context | T4.4 | 提问"当前笔记"类问题命中 |
| T4.7 ✅ 2026-10-14 | 权限模式：每 vault Safe/Power 两档（Safe 只挂只读工具） | T4.3 | Safe 下无写工具 |
| T4.8 ✅ 2026-10-14 | AI commit message（commit 对话框按 diff 生成） | T4.2, T6.4 | 生成可编辑草稿 |

## Phase 5 — Git 同步

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T5.1 ✅ 2026-10-15 | Git UI 分层：非 git vault 显示初始化入口；`git_enabled` 全局开关 | T0.6 | 两种 vault 状态 UI 正确 |
| T5.2 ✅ 2026-10-15 | Git 面板：status 变更列表、diff 查看、commit 对话框 | T0.6 | 提交后状态栏 ahead+1 |
| T5.3 ✅ 2026-10-15 | pull/push/remote：ahead/behind badge、添加 remote（历史兼容校验） | T5.2 | 对接 GitHub 仓库推拉成功 |
| T5.4 ✅ 2026-10-15 | clone 为新 vault | T5.3 | clone URL → 打开 |
| T5.5 ✅ 2026-10-15 | 冲突解决模态（按文件 ours/theirs） | T5.3 | 制造冲突可解决 |
| T5.6 ✅ 2026-10-15 | 同步状态机 + 状态栏 badge/弹层 | T5.2 | 五态切换正确 |
| T5.7 ✅ 2026-10-15 | AutoSync（可配间隔自动 pull + ff 后 reload） | T5.3 | 到点自动同步 |
| T5.8 ✅ 2026-10-15 | 文件历史 + 历史版本查看/恢复 | T5.2 | 可回滚单笔记 |
| T5.9 ✅ 2026-10-15 | AutoGit（空闲自动 checkpoint） | T5.7 | 阈值触发自动 commit |

## Phase 6 — UI 框架完备

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T6.1 ✅ 2026-10-15 | 四栏布局成品化：拖拽调宽、折叠记忆、右面板互斥（属性/TOC/Git/Chat/设置） | T0.9 | 布局状态持久化 |
| T6.2 | 命令清单单一来源 `appCommandManifest.json` + 命令面板（Cmd+K） | T0.9 | 命令/快捷键/面板三处同源 |
| T6.3 | 快捷键体系全量接入 | T6.2 | 清单中全部快捷键生效 |
| T6.4 | 多 tab + 导航历史（Cmd+[/]、Cmd+1-9） | T6.1 | tab 状态持久化恢复 |
| T6.5 | NoteList 成品化：虚拟滚动、snippet、chip、多选批量操作、排序持久化 | T6.1 | 1 万条笔记流畅 |
| T6.6 | Saved Views：`views/*.json` + 过滤引擎 + 侧边栏管理 | T6.5 | 视图保存/切换/拖拽排序 |
| T6.7 | 主题：light/dark/system 完整走查所有面板 | T0.9 | 无硬编码颜色残留 |
| T6.8 | 空态/加载态/错误态全面补齐 | T6.1 | 每个面板有空态设计 |
| T6.9 | 右键菜单（列表/编辑器/文件夹树） | T6.1 | 关键操作均有入口 |

## Phase 7 — 设置页成品化

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T7.1 | 分区设置页骨架 + 导航 | T0.9 | 8 个分区可切换 |
| T7.2 | AI/Embedding/Git/更新/外观 各分区表单（迁移 Phase 3/4/5 的临时 UI） | 对应模块 | 配置即存即用 |
| T7.3 | per-vault 设置（`.stride/` 内） | T7.1 | vault 间互不影响 |

## Phase 8 — 升级与发布

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T8.1 | 接入 tauri-plugin-updater：latest.json endpoint + minisign 签名密钥 | T0.4 | 本地模拟更新检查通过 |
| T8.2 | UpdateBanner：release notes + 后台下载进度 + 重启按钮（复用现有 UI 改造） | T8.1 | 全流程演示环境验证 |
| T8.3 | 启动自动检查 + 手动检查入口 + 通道设置 | T8.1 | 开关生效 |
| T8.4 | GitHub Actions 发布流水线：macOS arm64/x64 构建、签名、生成 latest.json 发 Release | T8.1 | tag 触发自动发版 |
| T8.5 | 退役旧 updater（`updater.ts` 进程 handoff 方案）与 Node server | T8.1 | server/ 目录删除，打包自洽 |
| T8.6 | 应用图标、bundle 元信息、`stride://` deep link | T8.4 | 安装包完整 |

## Phase 9 — 打磨

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T9.1 | 大 vault 性能：1 万笔记扫描/索引/列表/搜索基准 + 优化（worker 解析、缓存快照） | Phase 1-3 | 冷启动 < 3s |
| T9.2 | Playwright e2e 覆盖核心流（开库/编辑/搜索/agent/git/升级提示） | 各 Phase | CI 全绿 |
| T9.3 | Neighborhood 模式 | T1.9 | 邻域分组 + pivot |
| T9.4 | 图谱视图（可选增量） | T9.3 | 力导向图可交互 |
| T9.5 | PDF 导出 / 数学公式 / 只读预览 | T2.11 | 按需 |
| T9.6 | AI 模式命令面板 / AI workspace 弹出窗 | T4.5 | 按需 |
| T9.7 | Windows/Linux 适配走查（TauriFS/GitBackend 路径处理） | T8.4 | 三平台冒烟 |

---

## 里程碑建议

- **M1（基座可用）**：Phase 0 + Phase 1（T1.1-T1.11）→ Chrome 里可调试的笔记库
- **M2（编辑器与搜索）**：Phase 2 核心（T2.1-T2.9）+ Phase 3 → 日常可记录可检索
- **M3（Agent 与 Git）**：Phase 4 核心（T4.1-T4.7）+ Phase 5 核心（T5.1-T5.6）→ 复刻 tolaria 主体体验
- **M4（产品化）**：Phase 6-8 → UI 完备 + 可发布
- **M5（打磨）**：Phase 9
