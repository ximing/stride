# 外部 Agent 脚本

## 分发与运行

复制整个 `stride/` skill 目录，保留以下相对路径即可。运行脚本只需要 **Node.js 18 或更新版本**，无需 `npm install`、Stride 源码、`node_modules`、应用运行或网络连接。Node.js 运行时需接收方自行提供，目录不附带操作系统专属二进制。

```text
stride/
  SKILL.md
  references/
    cli.md
    vault-files.md
    migration.md
  scripts/
    stride.mjs
    stride.test.mjs
    lib/
      document.mjs
      relations.mjs
      vault.mjs
```

下面命令均在 skill 目录运行；从其他目录运行时，把 `scripts/stride.mjs` 换为该脚本的实际绝对路径。Vault 必须是用户选定的内容目录，不是 skill 目录或源码仓库。

```bash
node scripts/stride.mjs --help
node scripts/stride.mjs list --vault /path/to/vault
node scripts/stride.mjs read --vault /path/to/vault --note projects/alpha
```

`--note` / `--target` 是精确、区分大小写的相对文件 ID，不带 `.stride.json`。工具不跟随 Vault 内的符号链接，枚举时跳过隐藏目录、隐藏文件和 `node_modules`。全库列举/关系操作若遇到损坏文档会报错，不静默跳过，以免误判重名或反链。

除 `--help` 输出说明外，成功输出 JSON 到 stdout；失败输出 `{ "error": { "code": "…", "message": "…" } }` 到 stderr，退出码为 1。工具不会修改应用配置、提交 Git 或调用网络。

命令行参数值若以 `--` 开头会被拒绝，避免漏填参数时把 `--dry-run` 当正文而意外写入；这类文字使用 `apply` JSON 或 `--text-file` 传入。长正文也优先用文件或 stdin，避免 shell 转义问题。

## 先读再改

`read` 返回：

- `revision`：原文件字节的 SHA-256。所有写操作都要求 `--revision` 匹配。
- `blocks`：每个节点的 `ref`、`type`、可读 `text`，标题另含 `level`。例如 `b2` 是第三个顶层节点，`b2.0` 是它的第一个子节点；text 叶节点也有引用。
- `document`：完整原始文档，用于理解格式及复杂内容，通常无需模型重新生成。

定位目标后使用返回的 ref 和 revision。**每次独立写入后使用新的返回值**；预览中的 revision 代表候选内容，未落盘前不能用它提交。不要从节点摘要重新拼装整篇 JSON。

### 精确修改文字

```bash
node scripts/stride.mjs replace-text \
  --vault /path/to/vault --note projects/alpha --revision ORIGINAL_HASH \
  --block b1 --old '周五发布' --new '周一发布' --dry-run
```

检查 `preview` 后，用**同一个原始 revision** 去掉 `--dry-run` 执行。该命令要求选中子树内恰好有一处匹配，且匹配完整位于一个 text 节点中；保留该节点的 marks。重复文字可选更细的 text ref；跨不同格式节点的文字需分成几次替换并用 `apply` 一起提交。`--new ''` 删除匹配文字，删空后移除 text 节点。

首个标题 H1 及其后代受保护，不能用正文编辑命令改标题。改名涉及 `title` 和入链维护，按 Vault 文件参考执行。

### 插入段落与删除块

```bash
node scripts/stride.mjs insert \
  --vault /path/to/vault --note projects/alpha --revision ORIGINAL_HASH \
  --after b1 --text-file /path/to/new-content.txt

node scripts/stride.mjs delete-block \
  --vault /path/to/vault --note projects/alpha --revision LATEST_HASH \
  --block b2
```

- 插入可用 `--text` 或 `--text-file`（二选一），`--text-file -` 从 stdin 读取。默认追加到末尾，`--before` / `--after` 只接受顶层节点，不允许插入到标题 H1 前面。
- 文本按字面插入：空行分段，单个换行变为 `hardBreak`。**不解析 Markdown**；`**文字**` 会保留星号。要编辑现有带格式文字，用 `replace-text`；复杂富文本创建使用应用工具或按文件参考构造，不通过整文档 Markdown 往返。
- 删除块默认拒绝包含图片、表格、代码、双链或未知节点的子树。只有用户明确要删除这些内容时才传 `--allow-rich-delete`；这表示删除整个选中子树。
- 删除列表项、单元格的最后一个段落时，保留必要的空段落；不支持的容器操作报错。工具保留未知节点，但不具备应用所有自定义节点的 schema 验证能力。

## 关系查询和维护

```bash
node scripts/stride.mjs relations list --vault /path/to/vault --note projects/alpha

node scripts/stride.mjs relations add \
  --vault /path/to/vault --note projects/alpha --revision ORIGINAL_HASH \
  --kind belongs_to --target projects/team

node scripts/stride.mjs relations remove \
  --vault /path/to/vault --note projects/alpha --revision LATEST_HASH \
  --kind belongs_to --target projects/team
```

`kind` 支持 `belongs_to` / `related_to`。`list` 返回出站属性关系、正文双链、反链和派生关系；未解析/歧义目标有 `resolvedId: null`，`candidates` 列出候选。

写关系时 `target` 必须是 `list` 返回的现存精确 ID。脚本沿用 `belongs to` / `related to` 等已有键，优先存唯一标题双链，重名时尝试 ID；若标题遮蔽了该 ID、同名键重复或现有关系有歧义则报错。已有指向同一 ID 的关系不重复添加。移除时识别 ID/标题/别名双链，只删除对应 token，保留普通文字及其他关系；重复移除已不存在的关系不产生修改。断链目标不存在时需按文件参考精确清理。

关系只写源文档；删除 `B has A` 要修改 A 的 `belongs_to`。若双方各存了一条相关关系，删除其中一条不会删除另一条。自定义属性关系暂不通过此命令编辑。

## 一次提交多项修改

把简单操作列表存为 `operations.json`，无需生成 TipTap 文档：

```json
[
  { "op": "replace-text", "block": "b1", "old": "周五发布", "new": "周一发布" },
  { "op": "insert", "after": "b1", "text": "新增进展。\n\n下一步计划。" },
  { "op": "delete-block", "block": "b2" },
  { "op": "relation-remove", "kind": "belongs_to", "target": "projects/old-team" },
  { "op": "relation-add", "kind": "belongs_to", "target": "projects/new-team" }
]
```

```bash
node scripts/stride.mjs apply \
  --vault /path/to/vault --note projects/alpha --revision ORIGINAL_HASH \
  --operations /path/to/operations.json --dry-run
```

也可用 `--operations -` 从 stdin 读 JSON。所有操作必须成功才会写入，单次 `apply` 只处理一篇文档。块引用固定指向本次读取的原节点，前面插入/删除不会让后续操作指错节点；已删节点不能再次操作，新插入节点需提交后重新读取才能引用。多次 `after` 同一原节点会在它后面逐次插入，后插的块离锚点更近；需要有序多段内容时用一条 insert 的空行分段。

## 写入保护和验证范围

工具在内存中应用操作、校验基础 JSON 结构，写前检查版本；关系变更还会检查参与解析的 Vault 文件清单和版本。正常写入使用同目录临时文件、同步文件数据并原子替换，再读回核对。没有内容变化则不重写文件。

同一文档的脚本写入由隐藏的 `.<文件名>.agent.lock` 排他锁协调。出现 `LOCKED` 时先检查是否还有写进程；仅在确认进程已停止后清理残留锁。工具不会自动强占锁。该锁**不约束 Stride 编辑器或其他程序**，版本检查和原子替换也不是跨程序事务；请先保存并停止相关笔记的并发编辑。`POST_WRITE_CONFLICT` 表示替换后读回发现冲突，可能已经发生写入，必须先重读，不能盲目重试。

`--dry-run` 不创建锁或临时文件，不改变 Vault。预览不是自动提交授权，也不保证稍后版本仍有效。需要恢复原文时可保留 `read.document` 或使用 Vault 原有备份/Git；脚本不提供多步撤销或自动备份。完成后刷新/重开 Stride 检查渲染，文件校验不代表已做界面验证。

## 随包测试

在收到的 skill 目录中运行，测试只使用系统临时目录：

```bash
node --test scripts/stride.test.mjs
```
