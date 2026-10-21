# `src/editor` TipTap 编辑器子系统说明

## 这个目录负责什么

本目录封装 Stride 的富文本笔记编辑器（基于 TipTap 3 / ProseMirror），负责将 `*.stride.json` 中的 `doc`（TipTap JSON）渲染为纸感编辑界面，并提供全部富文本块与内联扩展：

- **装配与壳层**：`editor.tsx`（主组件、防抖自动保存、H1 标题联动）、`extensions.ts`（扩展汇总注册）、`toolbar.tsx` / `toolbar-fit.ts` / `toolbar-overflow.tsx`（自适应顶部工具栏与气泡菜单）、`chrome.css`。
- **自定义块与内联节点**：
  - `wikilink.ts` & `wikilink-menu.tsx`：`[[` 触发笔记模糊搜索补全与内联原子节点
  - `slash.ts` & `slash-menu.tsx`：`/` 命令菜单与扩展注册机制（`registerSlashCommand`）
  - `callout.ts`：多类型提示块与 `==highlight==` 输入规则
  - `task.ts`：任务列表与完成度联动
  - `table*.ts` & `table-menu.tsx`：表格扩展、单元格操作菜单与键盘导航
  - `codeblock.ts` & `code-language*.ts`：基于 `lowlight` 的语法高亮代码块与语言切换/复制
  - `math*.ts` & `latex-delimiters.ts`：KaTeX 行内/块级公式渲染与折叠编辑
  - `mermaid-*.ts`：Mermaid 图表节点视图与 SVG 渲染
  - `image.ts` & `image-resize.ts`：图片粘贴/拖拽写入 `attachments/`、尺寸调整与预览
- **粘贴与查找**：`paste-plugin.ts` / `markdown-paste.ts` / `markdown-pm.ts`（Markdown 与富文本粘贴转 ProseMirror 节点）、`find*.ts` & `find-bar.tsx`（页内查找替换与高亮装饰）。

## 放置约束

- **应该放这里**：TipTap Extension、ProseMirror Plugin、NodeView、编辑器专属浮层（Slash 菜单、Wikilink 菜单、表格菜单、查找栏）及编辑器单测。
- **不应该放这里**：
  - 笔记文件的磁盘读写、双链图谱构建或全局搜索逻辑（属于 `@stride/core` 和 `src/services/`）。
  - 通用基础 UI 原语（如通用 Modal、Button、Select 应放在 `src/ui/` 并在此复用）。

## 开发偏好

1. **序列化往返零丢失（Roundtrip Integrity）**：
   - 新增或修改任何自定义 Node / Mark 的 `attrs`、`parseHTML`、`renderHTML` 时，必须确保 TipTap JSON -> 保存 -> 重新加载完全无损，并通过 `roundtrip.test.ts` 验证。
2. **快捷键避让原则**：
   - 编辑器扩展严禁抢占应用级全局快捷键：例如 `Mod-k` 属于全局命令面板（`DocLink` 已清空快捷键），`Mod-,` 属于打开设置页（`DocSubscript`/`DocSuperscript` 已清空快捷键）。
3. **弹窗与输入交互**：
   - 编辑器内需要用户输入（如插入链接、编辑公式）时，必须使用 `prompt.tsx`（基于 `src/ui/modal.tsx`），严禁使用 `window.prompt` / `window.confirm`。
4. **中文输入法（IME）兼容**：
   - 涉及回车、斜杠或括号触发的键盘插件时，注意参考 `ime-enter.ts` 检查 `isComposing` 状态，避免打断中文输入法选词。
