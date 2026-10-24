# Vault 文件操作

用于已获用户授权、可直接访问 Vault 的外部 Agent。以下是存储格式和内容维护流程，不依赖 Stride 源码环境。

## 文件与 ID

- Vault 根目录由用户选择；不是 Stride 安装目录或源码目录。
- `Projects/alpha.stride.json` 的 ID 是 `Projects/alpha`，包含相对目录，不含 `.stride.json`；ID 不是永久 UUID，移动文件会改变 ID。
- 文件内保存 `format`、`title`、`type`、`properties`、`doc`，不需要存 `id` 或 `plainText`。
- 普通笔记默认 `type: "note"`。路径使用 `/`；不含绝对路径、`..`、空路径段或反斜杠，实际路径必须留在 Vault 内。
- 枚举笔记时递归读取 `*.stride.json`，跳过 `.git`、`.stride`、`node_modules`。不要把附件当笔记处理，也不要改动索引、密钥或应用设置。
- 创建前检查路径是否存在。标题相同不代表允许覆盖；需要另建时使用不同文件名，例如 `alpha-2.stride.json`。
- 更新前读完整 JSON，保留不相关字段。若文件自读取后已变化，重新读取并合并本次修改。使用临时文件加替换保证单文件写入完整；多文件修改保留可恢复副本，放在 Vault 扫描范围之外。损坏或含 Git 冲突标记的文件不要覆盖成空文档。

## 完整例子：目录 + 分类 + 笔记 + 关系

假设用户指定的 Vault 中已经有唯一标题为 `Team` 的笔记。创建 `Projects/`，先检查没有同名定义或文件，再写以下两个文件。

`项目.stride.json`：

```json
{
  "format": "tiptap",
  "title": "项目",
  "type": "Type",
  "properties": {
    "_icon": "note",
    "_color": "gray",
    "visible": "true",
    "_order": "1"
  },
  "doc": {
    "type": "doc",
    "content": [
      { "type": "heading", "attrs": { "level": 1 }, "content": [{ "type": "text", "text": "项目" }] },
      { "type": "paragraph" }
    ]
  }
}
```

已有分类时，`_order` 可取已有有限数值的最大值加一；本例的 `1` 适用于首个分类。

`Projects/alpha.stride.json`：

```json
{
  "format": "tiptap",
  "title": "Alpha",
  "type": "项目",
  "properties": {
    "related_to": ["[[Team]]"],
    "status": "进行中"
  },
  "doc": {
    "type": "doc",
    "content": [
      { "type": "heading", "attrs": { "level": 1 }, "content": [{ "type": "text", "text": "Alpha" }] },
      {
        "type": "paragraph",
        "content": [
          { "type": "text", "text": "协作团队：" },
          { "type": "wikilink", "attrs": { "target": "Team", "alias": null } }
        ]
      }
    ]
  }
}
```

验证：Alpha 的 ID 为 `Projects/alpha`，分类是“项目”，属性关系指向 Team，正文也有可见引用。Team 端的反向关系由应用计算，不写额外 `backlinks` 文件或字段。Team 不存在时，先按用户意图创建目标或说明尚未解析，不能声称关系已经验证。

## 正文与属性

- `doc` 是 TipTap 节点树。段落为 `paragraph`，文字为 `text` 节点的 `text` 值。空段落用 `{ "type": "paragraph" }`，不创建空字符串 text 节点。
- 首个顶层 H1 会优先作为读取标题。新建时让该 H1 与顶层 `title` 一致；已有笔记只改 `title` 而保留旧 H1，读回时仍可能显示旧标题。
- 修改正文保留节点的 `attrs`、`marks`、`content`，不要用纯文本或 Markdown 往返覆盖。
- `properties` 值支持字符串、数字、布尔值、字符串数组；不使用任意嵌套对象或对象数组。
- `[[Team]]` 是关系值；单独的 `"Team"` 只是普通字符串。多个目标推荐 `["[[Team]]", "[[Roadmap]]"]`。
- 图谱解析先匹配标题，再匹配完整 ID，最后尝试把引用中的空白折叠为 `-` 后匹配 ID；标题和引用会去首尾空白，匹配忽略大小写。标题命中优先于 ID 命中，因此即使用路径，也要检查是否与另一篇笔记的标题冲突。多个同标题候选属于歧义，不依赖文件遍历顺序选择目标。
- `[[目标|别名]]` 可表示文字双链别名；节点形式用 `attrs.target` 和 `attrs.alias`。修改引用保留别名。
- 下划线开头属性通常在普通属性 UI 中隐藏。分类定义常用 `_icon`、`_color`、`_order`、`_sidebar_label` 与 `visible`；只需改变侧栏名称时使用 `_sidebar_label`，不必重命名分类。
- `visible: false` 或 `"false"` 隐藏分类导航，不删除定义或成员。`template` 是字符串，应用按普通段落文本处理；不要把它假设成 TipTap 模板 JSON 或 Markdown 渲染器。

## 重命名、移动与删除

### 重命名笔记

1. 记录旧标题、旧 ID、新标题、新路径；检查新路径冲突及重名标题。应用通常按新标题生成文件名并保留原目录，必须读取实际结果。
2. 外部改写时同步 `title` 与首个 H1，仅修改标题内容，保留其他节点。
3. 检查全库属性中的双链、正文 `wikilink.attrs.target`、正文 text 中的双链，逐个解析到目标笔记后改写。标题改名需处理旧标题和旧 ID 引用；保留别名及其他文本，不对整份 JSON 做全局字符串替换。
4. 重命名 Type 定义时，还要将成员的 `type` 从旧分类标题迁移到新标题，并检查引用该分类的保存视图等配置。普通双链改写不能代替这一步。
5. 写入并重新读取受影响文件，确认旧路径没有残留副本，引用仍解析到同一内容。如果无法明确某条引用的目标，先解决歧义再修改它。

### 移动笔记或目录

标题可保持不变，但 ID 随相对路径变化。移动前列出受影响笔记的旧/新 ID 映射；检查每个目的文件是否存在，不覆盖合并。标题引用通常保持有效，路径 ID 引用必须更新。目录移动对所有后代笔记重复此检查，附件的相对引用也需检查。不要因为磁盘移动成功就假定图谱或搜索已刷新。

### 管理分类与删除

- 改分类：合并保留原 `properties` 与 `doc`，只修改笔记的 `type`。批量处理先确定成员清单。
- 合并分类：先复用/创建目标定义，再把旧分类所有成员迁移，核对后按用户要求处理旧定义。
- 取消分类：设为 `note`。删除定义文件本身不会自动重新分类成员。
- 归档保留原文件，设置 `properties.archived: true`；恢复时移除该属性或设 `false`。
- 删除笔记前检查入链，按用户要求处理失效引用；删除目录前检查全部内容，包括附件和隐藏文件，不仅是笔记。需要删除整个非空目录时，确认用户授权覆盖其中内容。
- Git 可用于核对变更与恢复已提交版本；本技能不隐含授权提交、推送或清理用户的其他未提交修改。

## 读回检查

用 JSON 解析器读回每个变更文件，验证字段类型和 TipTap 根节点；核对首个 H1、`title`、文件路径及预期 ID。按完整 Vault 内容解析关系与分类成员，保留原有未涉及的节点。最后在可访问的 Stride 界面刷新并检查目录、分类列表、笔记正文和关系；未做界面验证时如实报告。
