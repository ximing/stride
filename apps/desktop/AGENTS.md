# `@stride/desktop` 源码地图

行为约束见同目录 `CLAUDE.md`。这里只记录 `src/` 的模块边界。改完目录结构时，同步改本文件和对应的 `CLAUDE.md`。

## 顶层

- `main.tsx`：注册 Service、按固定顺序引入样式、挂载应用。
- `app.tsx`：Chooser 与四栏工作台。对外重新导出测试用的 `Rail`、`GitStatusBadge`、`UpdateBanner`。
- `appCommandManifest.json`：全局命令和快捷键的唯一清单。
- `styles.css`：应用壳层样式的 `@import` 入口，分片在 `styles/`。不要把选择器写回入口文件。
- `dev/`：`/dev/components` 组件画布。
- `inspect-*.ts` 与仓库里的 `inspect/`：调试代理通道。

样式入口顺序（`main.tsx`）就是层叠顺序：`ui/tokens.css`、`styles.css`、`ui/primitives.css`、`ui/shell.css`、`ui/panels.css`、`ui/overlays.css`、`editor/chrome.css`。

## `src/services/`

一个业务域一个目录。生产代码不引入 `src/ui` 或 `src/editor`（测试文件可以渲染面板）。域之间通过 `resolve(OtherService)` 协作，不要为了省事合成一个上帝文件。

| 目录 | 职责 |
| --- | --- |
| `vault/` | `VaultService`、`FolderService`。Vault 的打开、笔记正文、属性与索引是同一份响应式状态，`VaultService` 保持一个类。 |
| `notes/` | 笔记列表与编辑器标签页。 |
| `layout/` | 栏宽、折叠、舞台缩放。 |
| `views/` | 保存的视图。 |
| `search/` | 列表筛选、快速打开、搜索面板。 |
| `commands/` | 命令绑定、命令面板状态、右键菜单模型。 |
| `git/` | `GitService`。 |
| `chat/` | 对话回合、vault 宿主、`ChatService`。 |
| `settings/` | 设置读写与设置页状态。 |
| `update/` | 更新检查与安装。 |
| `appearance/` | 主题与笔记外观。 |
| `platform/` | 深链、浮层互斥这类宿主杂项。 |

## `src/ui/`

| 目录 | 职责 |
| --- | --- |
| `primitives/` | Button、Input、Select、Tabs、Modal、Menu、Toast、Tooltip、EmptyState 等设计系统原语。不引用具体业务面板，不引用 Service。 |
| `shell/` | 顶栏、侧栏、状态栏、标签条、缩放手柄、更新条。 |
| `note-list/`、`folders/` | 中间列表与文件夹树。 |
| `panels/` | 右栏宿主、属性、大纲。 |
| `git/`、`chat/` | 右栏里的 Git 与对话面板。 |
| `overlays/` | 命令面板、快速打开、搜索面板、右键菜单。 |
| `views/` | 保存视图的编辑弹层。 |
| `settings/` | 设置中心。各分区在 `settings/sections/`。 |

功能面板可以引用 `primitives/` 和 Service。原语不要反向引用面板。`tokens.css` 保持一份，不要按主题拆开。`primitives.css`、`shell.css`、`panels.css`、`overlays.css` 只做 `@import`，规则写在同名目录的分片里。

## `src/editor/`

根上只留装配：`editor.tsx`、`extensions.ts`、`index.ts`、`prompt.tsx`、`ime-enter.ts`、`roundtrip.test.ts`。扩展按目录分开放在 `wikilink/`、`slash/`、`callout/`、`task/`、`table/`、`code/`、`math/`、`mermaid/`、`image/`、`paste/`、`find/`、`link/`、`menu/`、`toolbar/`。`chrome.css` 是编辑器样式入口，分片在 `chrome/`。

编辑器可以引用 `ui/primitives` 和 Service。笔记读写、图谱和全局搜索不要放进这里。
