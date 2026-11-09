# Markdown 转成 Stride 笔记

本文件是语法、frontmatter 和警告码的唯一说明。怎么调用命令见 [cli.md](cli.md)。什么时候该用转换、什么时候该用逐字修改，见 [SKILL.md](../SKILL.md) 的「改几个字，还是写入排版」。

转换器在 `scripts/lib/markdown.mjs`，随 skill 分发。它不读取 Vault，不解析双链目标，也不依赖 Stride 源码或 npm 包。

## 三条边界

- `insert` 按字面插入。`**文字**` 会留下星号。要排版就用 `import`、`insert-markdown` 或 `replace-block`。
- `replace-text` 只改一个 text 节点里的一段文字，并保留这个节点的 marks。改几个词用它。
- 不要把一篇已经写好的富文本笔记整篇转成 Markdown 再转回来。Markdown 表达不了的节点、属性和 marks 会丢掉。转换器只负责新建笔记，或插入/替换本次给出的块。

## 命令各自做什么

| 命令 | 作用 |
| --- | --- |
| `convert --from FILE` | 只把 Markdown 打成笔记 JSON。不需要 `--vault`，不写文件 |
| `import --note ID --from FILE` | 新建这篇笔记。已有文件报 `EXISTS`，不会覆盖 |
| `insert-markdown` | 把若干顶层块插进已有笔记 |
| `replace-block` | 用这些块换掉一个顶层块 |

`convert` 和 `import` 还可带 `--title`、`--type`。`import` 可加 `--dry-run`。`insert-markdown` 和 `replace-block` 要原始 `--revision`，预览用 `--dry-run`。`apply` 里的操作名也是这两个。

以 `--` 开头的正文不能直接当 `--markdown` 的参数。frontmatter 或这类正文用 `--markdown-file`，stdin 用 `-`。`--from -` 同样读 stdin。

`insert-markdown` 和 `replace-block` 遇到合法 frontmatter 会失败，错误码 `FRONTMATTER`。frontmatter 只在 `convert` / `import` 生效。这两个插入命令也不额外补一个空段落。

## 新笔记的标题、类型和属性

`import` / `convert` 生成 `{ format: "tiptap", title, type, properties, doc }`。

标题按这个顺序，只取一个：

1. `--title`。与现有首个 H1 的可见文字不同时，换成纯文本 H1，警告 `title-replaced`。文字相同则保留原来的 H1，包括其中的 marks。
2. 正文第一个块就是 H1。用它的可见文字做标题。frontmatter 的 `title` 不同时报 `title-mismatch`，仍以这个 H1 为准。
3. frontmatter 的非空 `title`。开头不是 H1 时，在最前面补一个 H1，原来的段落和后出现的标题都保留。
4. `import` 再用笔记 ID 的最后一段。`convert` 没有这份回退；没有标题时 `title` 为空字符串，`titleSource` 为 `missing`，也不会凭空造 H1。

可见标题由 text 节点和 wikilink 的 target 拼成，空白会折成一个空格。

`type` 优先用 `--type`，否则用 frontmatter 的非空字符串，再否则是 `note`。`--type` 换掉了 frontmatter 的 type 时报 `type-replaced`。不要根据目录或正文猜测类型。

`title` 和 `type` 是文档字段，不会再放进 `properties`。其余键：

- 字符串、数字、布尔值、字符串数组原样进入 `properties`。
- `null` 省略，警告 `frontmatter-skipped`。
- 嵌套对象、嵌套数组存成 JSON 字符串，警告 `frontmatter-degraded`。
- 只含字符串、数字、布尔值或 null 的列表会改成字符串数组，警告 `frontmatter-coerced`。null 项变成空字符串。
- 解析到一半遇到无法识别的行、重复键、或 title/type 不是非空字符串时，整个开头的 `---` 块留在正文，警告 `frontmatter-unparsed`。
- 开头的 `---` 没有结束标记时，不当作 frontmatter，原文留在正文，没有这条警告。

支持的写法是子集：普通标量、`[a, b]`、缩进的 `-` 列表，以及 `|` / `>` 后面的缩进文本。`|` 和 `>` 只去掉每行的统一行首空白，保留行尾空格，空行会结束这段；两者都不是完整的 YAML 折叠规则。嵌套列表和嵌套对象保留层级后存成 JSON 字符串，并带 `frontmatter-degraded`。日期保持原文，不补时区，也不把 `2024` 变成日期。

新建笔记若最后一个块不是段落，会补一个空段落。这是编辑器习惯，不是多出来的正文。

## 会写成编辑器节点的语法

| Markdown | 节点 |
| --- | --- |
| 段落 | `paragraph`。空行分段 |
| 同一段里的软换行 | 合成一个空格，因此加粗、斜体可以跨行 |
| 行尾两个空格，或单独一个 `\`，且后面还有这一段的下一行 | `hardBreak` |
| `#` 到 `######` | `heading`，`attrs.level`。行尾、前面有空格的 `#` 会去掉 |
| 紧接在段落后面、整行只有 `=` 或 `-` | setext 标题，级别 1 或 2。空行后再写 `---` 才是分隔线 |
| `***`、`---`、`___` 这一类至少三个标记 | `horizontalRule` |
| `**` 或 `__` | bold。`__` 两侧不能贴着字母、数字或下划线 |
| `*` 或 `_` | italic。`_` 两侧不能贴着字母、数字或下划线，否则保持原文 |
| `***` 或 `___` | 同时 bold 和 italic。`___` 同样要求词边界 |
| `~~` | strike |
| 反引号 | code mark |
| `==` | highlight |
| `[文字](url)`、`[文字](url "title")` | link mark，可带 `title`。相对 `.md` 链接也只是 link，不会改成笔记双链 |
| `<https://…>`、`<http://…>`、`<mailto:…>` | link mark |
| `[[目标]]`、`[[目标\|别名]]` | `wikilink`。目标和别名按字面保存，不再解析里面的 Markdown。没有别名就不写 `alias`。不查 Vault，不判断目标是否存在 |
| `$…$` | `inlineMath` 的 `latex`。`$` 后面和结束 `$` 前面不能是空白，中间不能换行 |
| 单独一行的 `$$`，到下一行只有 `$$` | `blockMath`。同一行的 `$$…$$` 也可以。结束符必须独占一行，`x$$` 不会结束 |
| `\[…\]`、`\(...\)` | 先改写成 `$` / `$$`，代码块和行内代码里的不改 |
| ` ```lang ` 或 `~~~` | `codeBlock`，`language` 取信息行的第一个词。里面的 `#`、双链、frontmatter 不再解析 |
| 信息行是 `mermaid` 或 `mmd` | `mermaid`，`attrs.view` 为 `render` |
| 缩进四个空格或一个 Tab | 无语言的 `codeBlock` |
| `-`、`*`、`+` 与 `1.` / `1)` | `bulletList` / `orderedList` 里的 `listItem`。列表项以段落开头 |
| 有序列表的第一项编号大于 1 | `orderedList.attrs.start`。编号是 1 时不写 start |
| `- [ ]`、`- [x]` | `taskList` / `taskItem`，`checked` 为 true 或 false |
| `>` | `blockquote`。下一行也必须以 `>` 开头，没有懒续行 |
| `> [!NOTE]`、`> [!TIP]`、`> [!WARNING]` 以及下一节的别名 | `callout`，`kind` 只有 `note`、`tip`、`warning` |
| 含 `\|` 的表头行，加下一行 `---` 分隔 | `table`。第一行是 `tableHeader`，其余是 `tableCell`，单元格里是段落。列数补齐到最多的一行。对齐用的冒号不保存 |
| `![alt](attachments/…)` 或 http(s) 图片 | `image`。`src` 之外只保留 `alt`。图片 title 会并进 alt。图片是块，会从段落里拆出来 |

callout 别名：`hint` 归 `tip`；`caution`、`important`、`danger` 归 `warning`；`info` 归 `note`。不认识的 `[!CUSTOM]` 仍是引用，标记文字留在正文里。

列表项之间的空行：下一项仍是同一种列表（普通项目、任务或有序），并且有序编号正好是「起始编号 + 已有项数」时，继续同一个列表。`1.` 空行 `2.` 是一个列表。`1.` 空行 `3.` 拆成两个列表，第二个保留 `start: 3`。普通列表空行后接到任务列表，也拆开。没有空行、却混着复选框和普通项时，整份当成任务列表，普通项记为未勾选，警告 `task-list-mixed`。

图片路径只有 `attachments/` 开头、且不含 `..` 和反斜杠，或者是 http(s) URL，才会变成图片节点。标题、表格单元格和链接文字里的图片保持原文，警告 `image-inline`，即使这条路径本身也不能嵌入。段落里放不进图片节点的路径保持原文，警告 `image-kept`。迁移时先把附件放到合法路径，再让链接指向它，见 [migration.md](migration.md) 的两遍处理。

## 警告

`warnings` 是 `{ code, message }` 数组。`convert` 和 `import` 总会带上。写入结果只在这次操作含有 `insert-markdown` 或 `replace-block` 时带上。退出码 0 只表示写成功，不表示没有降级。

| code | 含义 |
| --- | --- |
| `frontmatter-coerced` | 列表项改成了字符串 |
| `frontmatter-degraded` | 嵌套值存成了 JSON 字符串 |
| `frontmatter-skipped` | `null` 被省略 |
| `frontmatter-unparsed` | frontmatter 无效，原文留在正文 |
| `image-kept` | 图片路径不能变成图片节点 |
| `image-inline` | 图片出现在标题、单元格或链接文字里，保持原文 |
| `link-kept` | 链接包不住公式或双链，网址另外留在文字里 |
| `unclosed-fence` | 代码围栏没关闭，内容仍存成代码 |
| `unclosed-math` | `$$` 块没关闭，按正文保留 |
| `empty-math` | 空的 `$$` 块按正文保留 |
| `html-kept` | HTML 块按段落和硬换行保留，不渲染 |
| `task-list-mixed` | 同一列表里混有复选框和普通项 |
| `title-replaced` | `--title` 换掉了原来的 H1 |
| `title-mismatch` | frontmatter 标题和 H1 不同，采用 H1 |
| `type-replaced` | `--type` 换掉了 frontmatter 的 type |

参考式链接、脚注、定义列表和段落中的 HTML 标签没有单独的警告，原文留在 text 节点里。内容还在，只是没有变成对应节点。

## 不要指望转换器做的事

- 不把 `[[目标]]` 或相对链接解析成 Vault 里的笔记。关系仍用 `relations list`，迁移仍走两遍映射。
- 链接地址、链接 title 和图片地址不能从一行断到下一行。跨行时整段保持文字，不会把换行写进 `href` 或 `src`。
- 不复制附件，不改写 `../` 图片。
- 代码块里的 Markdown 保持源码。
- 表格对齐、脚注、定义列表没有单独节点。
- 同一行里成对的 `$`，开头后面和结尾前面都没有空白时，会当成行内公式。`$5 today$` 会变成公式；`$5 and $10` 这种结尾前有空格的写法会保持原文。
- 打开并保存笔记时，编辑器可能补上表格单元格的 `colspan: 1`、`rowspan: 1`，代码块的 `collapsed: false`，以及图片的空 `width` / `height`。文件里不写这些默认值。读回时多出来的默认属性不是内容丢失。
- 替换顶层块会丢掉这一块里的 marks。块里若有双链、图片、代码、公式、表格、标注、分隔线或未知节点，必须显式 `--allow-rich-delete`（`apply` 里是 `allowRichDelete: true`），否则报 `RICH_CONTENT`。只含加粗等 marks 的段落不用这个标志，但整块仍会被换掉。
- 不能替换或插到标题 H1 前面，报 `TITLE_PROTECTED`。`replace-block` 只接受顶层块。
