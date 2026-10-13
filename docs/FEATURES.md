# Stride 功能清单

> 复刻 [tolaria](https://github.com/refactoringhq/tolaria)（local-first / git-first / AI-first 知识库），
> 四处关键差异：① 本地产物为 **TipTap 富文本 JSON**（非 Markdown）；② 搜索用 **vane**（默认 BM25，可选 embedding hybrid）；③ Agent 框架用 **pi-agent-core + pi-ai**（BYOK）；④ 自动升级同 tolaria（GitHub Release 后台下载 + 提示）。
>
> 技术栈：React 19 + TS + Vite + `@rabjs/react`（Service 响应式状态管理）+ pnpm workspace + Tauri 2。
>
> 来源：对 tolaria / inwit / vane / stride 现状的调研（2026-10-13）。

## 0. 核心理念（沿用 tolaria）

- **Files-first**：笔记就是文件（`*.stride.json`，TipTap JSON + properties），文件系统是唯一数据源，无数据库。
- **Git-first**：vault 即 git 仓库，同步/历史/冲突全靠系统 git CLI，零服务端依赖。
- **Offline-first / zero lock-in**：无账号、无云依赖。
- **AI-first but not AI-only**：内嵌 Agent 可读写 vault；vault 根目录维护 `AGENTS.md`/`CLAUDE.md`。
- **Keyboard-first**：命令面板 + 快捷键是核心交互。
- **Types as lenses**：`type` 字段是导航辅助而非 schema 校验；任何值为 `[[wikilink]]` 的属性自动成为关系。
- **Inbox 是派生视图**：无类型/无出链的笔记自动进入 Inbox，目标是周期性 Inbox Zero。

## 1. Vault 管理

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 1.1 | 打开 vault | 系统目录选择器（Tauri dialog）/ 浏览器 File System Access API 选目录 | P0 |
| 1.2 | 新建 vault | 指定目录初始化：写 `.stride/vault.json` 标记 + 种子类型文档 | P0 |
| 1.3 | 多 vault 注册表 | 浏览器：localStorage `stride:vaults`（id/label/color/icon/lastOpened）+ IndexedDB 目录句柄；Tauri：同一份元数据，label 为目录路径。启动恢复上次 vault。没有应用数据目录，所以浏览器侧不写 `vaults.json` 文件 | P1 |
| 1.4 | vault 切换器 | 状态栏/侧边栏切换 | P1 |
| 1.5 | Onboarding 欢迎页 | 三选一：新建空 vault / 打开已有文件夹 / 克隆示例库 | P1 |
| 1.6 | 文件监听 | 外部改动自动 reload（Tauri notify；浏览器模式下手动刷新按钮） | P2 |
| 1.7 | 文件夹树 | 侧边栏目录树：内联新建/重命名/删除/拖拽移动笔记 | P1 |

## 2. 笔记模型与关系图谱

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 2.1 | 笔记文件格式 | `*.stride.json`：`{format, title, type, properties, doc(TipTap JSON)}`（现有 @stride/core 已有，需浏览器化） | P0 |
| 2.2 | 标题模型 | 第一个 H1 即标题；写入 H1 后自动重命名文件（可关） | P0 |
| 2.3 | Type 系统 | `type: Type` 笔记即类型定义：icon/color/order/sidebar_label/template/sort/visible；类型文档带 Instances 列表 | P0 |
| 2.4 | 自定义属性 | properties 任意键值（string/number/bool/list）；`_` 前缀系统属性 UI 隐藏 | P0 |
| 2.5 | Wikilink | `[[note]]` 内联原子节点；未解析目标点击即创建；路径后缀解析 | P0 |
| 2.6 | Backlinks | Inspector 面板反链列表，点击导航 | P0 |
| 2.7 | 关系字段 | 值为 wikilink 的属性自动识别为关系（belongs_to/related_to/has…），人性化显示 | P0 |
| 2.8 | Inbox | 无类型/无出链笔记的派生集合；整理后自动前进下一条（可关） | P1 |
| 2.9 | Neighborhood 模式 | 选中实体笔记 → 列表变"邻域"：源笔记置顶 + 出链分组 + 反链分组，可 pivot | P2 |
| 2.10 | 重命名/移动全局改写 | 重命名笔记时重写全库 wikilink（crash-safe 事务）；附件同理 | P1 |
| 2.11 | Archive | `archived: true` 默认从列表隐藏；删除为永久删除 | P1 |
| 2.12 | 图谱视图（可选） | 力导向关系图页面（tolaria 刻意不做，作为 Stride 增量能力） | P3 |

## 3. 编辑器（TipTap）

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 3.1 | 基础富文本 | StarterKit 全量：粗斜体/删除线/标题/列表/引用/代码块/水平线 | P0 |
| 3.2 | Slash 菜单 | `/` 唤起块类型插入菜单（标题/列表/表格/代码/图片/分隔线…） | P0 |
| 3.3 | Wikilink 自动补全 | 输入 `[[` 弹出笔记模糊搜索菜单，选中插入 wikilink 节点 | P0 |
| 3.4 | 工具栏 | 气泡菜单（选中文本）+ 顶部固定工具栏 | P0 |
| 3.5 | 任务列表 | TaskList/TaskItem，可勾选，列表显示完成度 | P1 |
| 3.6 | 表格 | 插入/行列增删/表头 | P1 |
| 3.7 | 图片与附件 | 粘贴/拖拽上传存 `attachments/`；双击 lightbox；远程图片本地化 | P1 |
| 3.8 | Callout | 提示块（note/warning/tip… 多类型） | P2 |
| 3.9 | 代码块增强 | 低亮度语法高亮（低 overhead 方案，如 highlight.js 常用语言子集）、复制按钮 | P2 |
| 3.10 | 高亮 `==text==` | Highlight mark | P1 |
| 3.11 | 数学公式 | KaTeX inline/display | P3 |
| 3.12 | 自动保存 | 350ms~1.5s 防抖落盘；保存失败重试 + 状态指示 | P0 |
| 3.13 | TOC | 右侧大纲面板（H1-H3 树，点击跳转） | P1 |
| 3.14 | 字数统计/元信息 | 编辑器底部或面包屑栏 | P1 |
| 3.15 | PDF 导出 | 渲染导出 PDF | P3 |
| 3.16 | 只读预览模式 | 预览/编辑切换 | P2 |

## 4. 搜索（vane）

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 4.1 | BM25 全文搜索 | vane 索引全库笔记（默认模式，无需任何 key）；中文 jieba 分词内置 | P0 |
| 4.2 | 搜索面板 | Cmd+Shift+F：结果列表 + snippet + 分数，点击跳转并高亮 | P0 |
| 4.3 | 列表内联过滤 | 侧边栏笔记列表标题/属性即时过滤 | P0 |
| 4.4 | 快速打开 | Cmd+P 模糊查找笔记标题 | P0 |
| 4.5 | Embedding hybrid（可选） | 设置中填 OpenAI 兼容 endpoint/key/model/dim → 升级为 vector+BM25 RRF hybrid；key 失效自动降级 BM25 | P1 |
| 4.6 | 增量索引 | 保存/删除/重命名时 upsert；打开 vault 时全量重建（进度可见） | P0 |
| 4.7 | 编辑器内查找替换 | Cmd+F 当前笔记内查找替换 | P1 |

## 5. Agent（pi-agent-core + pi-ai）

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 5.1 | BYOK LLM 配置 | provider 目录（OpenAI 兼容 / Anthropic 兼容）：baseUrl/model/key；多配置 + 默认；key 加密存本地 | P0 |
| 5.2 | 对话面板 | 右侧 Chat 面板：消息流、Markdown 渲染、多会话 tab | P0 |
| 5.3 | 流式输出 | text_delta/thinking_delta 流式渲染；可中断（abort） | P0 |
| 5.4 | 工具调用可视化 | 工具卡片（名称/参数/结果摘要/耗时），思考块折叠展示 | P1 |
| 5.5 | Vault 工具集 | `read_note` / `read_active_note` / `search_vault`（走 vane）/ `write_note`（结构化改写，不毁文档）/ `create_note` / `append_to_note` / `list_notes` / `get_backlinks` | P0 |
| 5.6 | 上下文快照 | 发送 activeNote（标题/类型/属性/正文截断）+ 打开tab + vault 概览的结构化 JSON | P1 |
| 5.7 | 权限模式 | 每 vault Safe（只读+搜索）/ Power（可写）两档 | P1 |
| 5.8 | 命令面板 AI 模式 | Cmd+K 里直接给 AI 发指令 | P2 |
| 5.9 | AI 生成 commit message | commit 对话框按 diff 生成提交信息草稿 | P2 |
| 5.10 | Agent 写入保护 | write_note 基于 TipTap JSON 结构化合并，禁止压平文档；写入前快照可撤销 | P0 |

## 6. Git 同步

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 6.1 | 能力分层 | vault 可为非 git 纯文件夹；非 git 时 Git UI 显示"初始化"入口；全局 `git_enabled` 开关 | P0 |
| 6.2 | init | 自动 `.gitignore` + 初始 commit + 兜底 author；禁止在 home/Desktop 等宽泛目录 init | P0 |
| 6.3 | status / diff | 变更列表、未提交 diff 查看 | P0 |
| 6.4 | commit | 提交对话框（path-limited staging）；支持 AI 生成 message | P0 |
| 6.5 | pull / push / remote | remote status（ahead/behind）badge；添加 remote 校验历史兼容 | P1 |
| 6.6 | clone | 从 URL 克隆为新 vault | P1 |
| 6.7 | 冲突解决 | 冲突模态：按文件选 ours/theirs（三栏对比为增强） | P1 |
| 6.8 | 文件历史 | 单笔记 commit 历史 + 历史版本查看/恢复 | P2 |
| 6.9 | AutoSync | 可配间隔自动 pull；fast-forward 后 reload vault | P1 |
| 6.10 | AutoGit | 空闲/失焦自动 checkpoint commit（可配阈值、可 AI message） | P2 |
| 6.11 | 同步状态机 | idle/syncing/pull_required/conflict/error，状态栏 badge + 弹层 | P0 |

## 7. 自动升级

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 7.1 | tauri-plugin-updater | `latest.json` 静态 endpoint（GitHub Releases/Pages）+ minisign 签名 | P0 |
| 7.2 | 启动自动检查 | 启动 3s 后静默检查（可关）；网络错误静默 | P0 |
| 7.3 | UpdateBanner | release notes + 后台下载进度条 + "立即重启" | P0 |
| 7.4 | 双通道 | stable / alpha 通道设置项 | P2 |
| 7.5 | 手动检查 | 状态栏/菜单 "Check for Updates" | P1 |
| 7.6 | 发布流水线 | GitHub Actions：macOS arm64/x64 构建 + 签名 + 生成 latest.json 发 Release | P0 |

## 8. UI 框架与交互

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 8.1 | 四栏布局 | Sidebar(类型/视图/文件夹) ｜ NoteList ｜ Editor ｜ RightPanel(属性/反链/TOC/Git/Chat 互斥切换) + 底部 StatusBar；各栏可拖拽调宽、可折叠 | P0 |
| 8.2 | 设计系统 | CSS 变量主题 + 组件库（按钮/输入/菜单/弹层/Tooltip/Toast/Modal），Phosphor 图标，light/dark/system 主题 | P0 |
| 8.3 | 命令面板 | Cmd+K：命令 + 笔记跳转 + AI 模式；命令清单单一来源（`appCommandManifest.json` 模式） | P1 |
| 8.4 | 快捷键体系 | Cmd+N 新建 / Cmd+S 保存 / Cmd+P 快速打开 / Cmd+F 查找 / Cmd+Shift+F 全库搜索 / Cmd+[/] 历史导航 / Cmd+1-9 切 tab | P1 |
| 8.5 | 多 tab | 笔记多 tab 打开 + 导航历史（前进/后退） | P1 |
| 8.6 | NoteList | 虚拟滚动、snippet、日期、type chip、多选批量操作（归档/删除/改类型）、排序 | P1 |
| 8.7 | Saved Views | `views/*.json`：命名过滤视图（type/属性/排序条件），侧边栏可拖拽排序 | P2 |
| 8.8 | 空态/加载态/错误态 | 所有面板完备的空态、骨架屏、错误提示与重试 | P1 |
| 8.9 | 右键菜单 | 笔记列表/编辑器/文件夹树上下文菜单 | P2 |
| 8.10 | 状态栏 | vault 名、git 分支+同步状态、搜索索引状态、版本、AI 入口、更新提示 | P0 |

## 9. 设置

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 9.1 | 分区设置页 | 外观 / 编辑器 / AI(LLM) / Embedding / Git / 更新 / 隐私 / 快捷键 | P0 |
| 9.2 | 密钥安全存储 | LLM/embedding key 加密存储（Tauri keychain 插件 或 AES seal），掩码回显 `••••xxxx` | P0 |
| 9.3 | 外观设置 | 主题 light/dark/system、笔记宽度、字体大小 | P1 |
| 9.4 | AI 设置 | 多 provider 配置管理、默认模型、权限模式默认值 | P0 |
| 9.5 | Embedding 设置 | endpoint/model/key/dim；测试连接按钮；降级状态显示 | P1 |
| 9.6 | Git 设置 | auto_pull 间隔、autogit 开关与阈值、git 路径 | P1 |
| 9.7 | 更新设置 | 通道、自动检查开关 | P1 |
| 9.8 | per-vault 设置 | zoom、视图模式、git_setup_preference 等（存 `.stride/`） | P2 |

## 10. 调试与开发基础设施

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 10.1 | **FS 适配层** | `FileSystemBackend` 接口（read/write/list/mkdir/rename/delete/watch）：Tauri 实现（plugin-fs）+ Chrome 实现（File System Access API，目录句柄存 IndexedDB 持久授权） | P0 |
| 10.2 | **Chrome 全功能调试** | `pnpm dev` 纯浏览器跑起完整应用（vault 选目录 → 编辑/搜索/agent 全可用），配合 `/csi` 让 AI 直接操控调试 | P0 |
| 10.3 | Git 适配层 | Tauri 实现（plugin-shell 调系统 git）；Chrome 实现：isomorphic-git + LightningFS（或显式降级为 "Git 不可用"） | P1 |
| 10.4 | 搜索适配层 | vane WASM（`@vane-rs/web`，浏览器/ webview 通用）；embedding 走 HTTP | P0 |
| 10.5 | inspect daemon | 现有 agent 调试通道（snapshot/click/fill/evaluate/screenshot），保留并适配 Chrome | P1 |
| 10.6 | e2e | Playwright 浏览器模式 e2e（核心流：开库→建笔记→搜索→agent→git） | P1 |
| 10.7 | 单测 | core 领域逻辑 vitest 全覆盖（现有基础上扩展） | P0 |

## 11. 打包与分发

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| 11.1 | Tauri 打包自洽 | 打包后无外部 Node 依赖：业务逻辑全部跑在 webview（FS/Git/搜索走适配层） | P0 |
| 11.2 | 应用图标/元信息 | bundle 配置、deep link `stride://` | P1 |
| 11.3 | macOS 签名公证 | 发布流水线签名 + notarize | P2 |
| 11.4 | Windows/Linux 打包 | vane-wasm 方案天然跨平台（CLI sidecar 不支持 Windows 的问题被规避） | P2 |

## 刻意不做（沿用 tolaria 的意见化决策）

- 无插件系统、无回收站（永久删除）、无账号/云同步（同步 = git）、无每日笔记（用 type+日期属性表达）。
- 每日笔记、模板等通过 Type 的 `template` 属性覆盖。
