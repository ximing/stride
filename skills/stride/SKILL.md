---
name: stride
description: Use when an external agent needs to edit Stride document content, convert Markdown into a Stride note, add/remove document relationships or backlinks, manage vault notes, folders, Types, properties or archives, or import a Markdown/Tolaria vault. 适用于外部 agent 修改、续写、改写文档正文，把 Markdown 转成笔记，建立、替换、删除文档关系及整理知识库；不用于开发、构建或调试 Stride 本身。
---

# 使用 Stride 管理知识库

Stride 的 Vault 是一个本地文件夹，每篇笔记（文档）是 `*.stride.json` 富文本文档。外部 agent 使用本 skill 随附脚本编辑正文与关系，不需要 Stride 源码、开发服务器或内部 Service。分发时复制整个 skill 目录；脚本只依赖 Node.js 18+，无需安装 npm 包，不自动暴露 MCP/应用工具。

## 选择操作入口

1. 确定用户要操作的 Vault。当前工作目录可能是 Stride 源码仓库，不能自动当作用户知识库。已有 Vault 可含 `.stride/vault.json`，其中 `kind` 为 `stride-vault`；没有标记也可能是用户选定的普通文件夹。
2. 有应用提供的笔记工具时，使用实际暴露的工具及其参数。下文列出的工具属于内置 Agent，不代表外部 Agent 自动拥有这些工具，也不是 CLI 命令。
3. 外部 Agent 已能访问用户指定的 Vault 时，先读该 Vault 自己的 `AGENTS.md` / `CLAUDE.md`，再按 [随附脚本](references/cli.md) 操作正文与结构关系，优先让脚本处理 JSON。脚本未覆盖的目录、分类、自定义属性等任务按 [Vault 文件操作](references/vault-files.md) 执行。
4. 只有界面访问能力时，通过 Stride 的目录树、笔记编辑器、类型与属性/关系面板操作，按当前界面识别控件。没有写权限或对应入口时，明确缺少的能力，不虚构 API。

外部文件编辑前确保应用已保存相关笔记，避免与编辑器同时写同一文件；操作后在应用中刷新或重新打开 Vault，检查显示和搜索。不要假定所有宿主都会自动监测外部修改。

## 外部 Agent 快速入口

以下命令在 skill 目录中执行，也可将脚本替换为绝对路径。第一次使用先读 [脚本参数、批量操作和限制](references/cli.md)。

```bash
node scripts/stride.mjs list --vault /path/to/vault
node scripts/stride.mjs read --vault /path/to/vault --note projects/alpha
node scripts/stride.mjs --help
```

`read` 返回完整文档、可读节点引用（如 `b1`）及 `revision`。每次写入都必须传原始 `--revision`，可加 `--dry-run` 查看结果。不要让模型重写整篇 JSON，也不要手写整篇 TipTap。

## 改几个字，还是写入排版

精细修改保留 marks、未知节点和版本检查，适合小改动。它不适合从 Markdown 新建笔记或插入一整节排版。那种情况用随附转换器，仍然不用手写 JSON。语法和警告只写在 [Markdown 转换](references/markdown.md)，命令参数只写在 [cli.md](references/cli.md)。

| 要做的事 | 用 |
| --- | --- |
| 改几个词，并保留加粗、链接等 marks | `replace-text` |
| 插入没有排版的文字 | `insert`。星号和井号按字面保留 |
| 新建一篇笔记 | `import`。先看结果用 `convert`，它不写 Vault |
| 往已有笔记插入标题、列表、表格、代码或公式 | `insert-markdown` |
| 用一段排版换掉一个顶层块 | `replace-block`。含图片、表格、代码、双链等时要显式允许 |
| 删除一块，或改归属/相关 | `delete-block`、`relations` |
| 一次提交多步 | `apply` |

不要把已有富文本笔记整篇转成 Markdown 再转回来。`import` 发现同名笔记会失败，不会覆盖。转换当时不解析这篇笔记指向 Vault 里的哪一篇；相对链接和附件按 [迁移的两遍处理](references/migration.md) 做。

## 内容模型速查

| 用户意图 | Stride 中的表示 |
| --- | --- |
| 文件 / 笔记 | `<相对路径>.stride.json`，内容是 JSON，不是 Markdown |
| 目录 / 文件夹 | Vault 内的实际文件夹，可嵌套；移动目录不会改变分类 |
| 分类 / 类型 | 定义笔记的 `type` 为 `Type`，其 `title` 是分类名；成员笔记的 `type` 等于该分类名 |
| 归属关系 | 源笔记 `properties.belongs_to: ["[[目标标题]]"]` |
| 相关关系 | 源笔记 `properties.related_to: ["[[目标标题]]"]` |
| 自定义关系 | 任意属性值中的 `[[目标]]`，可用字符串或字符串数组 |
| 正文引用 | TipTap `wikilink` 节点，或文本中的 `[[目标]]` |
| 归档 | `properties.archived: true`；取消归档设为 `false` 或移除该属性 |

分类、目录和关系互相独立。例如把笔记放到 `Projects/`，不会自动归到“项目”分类；设 `type: "项目"` 也不会自动关联某个项目笔记。一个笔记只有一个 `type` 字符串；多重主题可用多个关系目标表达。

## 内置 Agent 工具

仅在当前环境实际暴露这些工具时使用；只有文件访问能力时直接走文件流程，不等待工具接入。

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `list_notes` | `{}` | 获得笔记 `id` 和标题 |
| `search_vault` | `{ "query": "关键词" }` | 搜索候选笔记 |
| `read_note` | `{ "id": "projects/alpha" }` | 读取完整 `doc`、属性及辅助纯文本 |
| `read_active_note` | `{}` | 读取当前打开的笔记 |
| `get_backlinks` | `{ "id": "projects/alpha" }` | 查看入链 |
| `get_relations` | `{ "id": "projects/alpha" }` | 查看属性关系、正文引用和入链 |
| `create_note` | `{ "title": "Alpha" }` | 创建笔记；使用返回的实际 ID |
| `append_to_note` | `{ "id": "…", "node": { "type": "paragraph" } }` | 追加一个 TipTap 块 |
| `write_note` | `{ "id": "…", "path": [1], "node": { "type": "paragraph" } }` | 替换一个已有节点，`[1]` 为第二个顶层块 |
| `insert_block` | `{ "id": "…", "index": 2, "node": { "type": "paragraph" } }` | 在顶层索引前插入块 |
| `remove_block` | `{ "id": "…", "path": [2] }` | 删除指定路径的节点 |
| `link_relation` / `unlink_relation` | `{ "id": "…", "kind": "belongs_to", "target": "Team" }` | 添加/删除源笔记关系；kind 也可为 `related_to` |
| `set_note` | `{ "id": "…", "type": "项目" }` | 修改普通笔记 title/type/archived；不改变 ID |
| `undo_note` | `{ "id": "…" }` | 恢复当前工具实例中该笔记最近一次写入前保存的快照 |

`write_note` 不是整文件写入：不能靠它设置 `properties`、`type` 或创建目录；`path` 必须非空且指向已有节点，嵌套路径逐层索引 `content`。先读 `doc` 再决定位置，第一块可能是标题 H1。读取结果中的 `plainText` 只用于理解，不用于重建原文档。

属性还有 `set_property`、`rename_property`、`remove_property`，分类有 `list_types`、`create_type`、`update_type`；按实际工具 schema 使用。目录管理、文件移动与笔记永久删除使用文件或界面入口。安全模式下以实际可用的只读工具为准，不绕过模式限制。`undo_note` 不会撤销创建，也不是持久的多步历史，不能假定一次撤销会还原整组操作。

## 常用任务

### 修改、续写、改写与删除正文

先读 [正文编辑步骤](references/vault-files.md#正文编辑步骤)，再执行：

1. 用路径/ID 与标题定位文档，读取完整 JSON；通过章节标题和上下文确认要改的节点，不能直接把搜索摘要或纯文本当作原文。
2. 明确编辑范围。改几个词用 `replace-text`。插入或替换一整节排版用 `insert-markdown` / `replace-block`，按 [Markdown 转换](references/markdown.md) 执行。不要为了改一节而重建整篇文档。
3. 有应用工具时使用 `write_note`、`append_to_note`、`insert_block`、`remove_block`；外部 agent 优先使用随附脚本。直接文件操作或应用工具增删后须重新定位路径；脚本 `apply` 内的引用固定指向原节点，独立调用间仍需使用新返回的引用和版本。未改到的 marks、图片、表格、公式和自定义节点保持原样。
4. 写前核对文件未变化，写后读回并比较变更范围。正文编辑默认不改标题、分类或关系；正文中的双链本身也是内容，按用户意图保留或修改。

### 从 Tolaria / Markdown Vault 迁移

迁移前读取 [迁移流程与验收](references/migration.md)。其中规定当前 Vault 的定位证据、范围清单、Markdown/YAML 转换、分类与引用映射、附件处理、重复执行和回滚。先在独立暂存目录转换并验证，再合入用户指定的 Vault；只给迁移建议或交接 prompt 时不写目标数据。

### 创建文件、目录与分类

- 先检索是否已有同名内容；不要因为重试重复创建。正文来自 Markdown 时用 `import`，不要照文件参考里的短例子手写长文档。
- 创建目录时只创建用户需要的实际文件夹。新笔记保留 `.stride.json` 扩展名，路径决定 ID。
- 创建分类前检查是否已有同标题且 `type: "Type"` 的定义笔记；复用已有分类。创建定义后，把成员的 `type` 设成定义标题，保持大小写一致。定义可放在普通目录中，不要求固定 `types/`。
- 修改正文时保留原有 marks、图片、表格、公式、自定义节点和未涉及的属性，只改变目标节点。
- 直接写文件的完整示例、标题 H1 规则与分类展示字段见 [Vault 文件操作](references/vault-files.md)。

### 建立、修改与删除关系

先找出目标笔记，确认标题是否唯一；图谱也可按不带扩展名的完整 ID 解析，重名时使用 ID 并验证实际目标。界面点击与图谱解析可能不同，尤其要检查路径引用能否正确导航。

- `belongs_to` 表示“当前笔记属于目标”；目标端自动展示派生的 `has`。
- `related_to` 在目标端自动展示反向相关关系。通常只写源端，不需要再手工写镜像关系。
- 保留已有关系，去重后添加目标；若原文件使用 `belongs to` / `related to` 键，沿用该键，不额外创建另一种拼写。
- 删除关系时只删除对应目标，保留其他目标和普通属性文本。若界面显示的是派生关系，修改实际存储关系的源笔记。
- 替换关系与修改关系类型见 [关系增删改步骤](references/vault-files.md#关系增删改步骤)。工具的 `target` 可接收 ID，但 `link_relation` 实际存标题双链；重名、ID 引用、别名引用需检查读回结果，必要时用获授权的文件入口精确修改。`set_property` 不允许写结构关系键或 `_` 系统键。
- 正文引用不等于属性关系。Inbox 包含“没有出站属性双链且未标记 `_processed`”的笔记；只设置分类、移动文件或加正文引用不会将笔记移出 Inbox。用户只要求标记已处理时可设 `properties._processed: true`，恢复未处理时移除它（有属性关系的笔记仍不进入 Inbox）。不为清空 Inbox 造无意义链接。

### 重命名、移动、归档与删除

优先使用应用已有的重命名/移动操作，并重新读取实际路径和关系。外部操作需按 [文件操作中的维护步骤](references/vault-files.md#重命名移动与删除) 同步标题、路径、引用及分类成员；不能只执行 `mv` 就宣布完成。

“归档”使用 `archived`，保留文件和引用。永久删除前检查反链及目录实际内容；只删除用户明确指定的范围。删除分类定义不等于删除成员，应先迁移成员类型。不要把“整理”自行解释为删除。

## 完成验证

重新读取所有变更文件，确认 JSON 能解析、`format` 为 `tiptap`、`doc.type` 为 `doc`，原有富文本结构仍在。检查路径无覆盖、分类成员匹配定义、关系解析到预期目标。涉及应用操作时再确认界面已反映结果；只有文件验证时明确这一验证范围。

向用户简要报告实际创建/修改的笔记路径、分类与关系，以及未完成项；不要把计划当成执行结果。
