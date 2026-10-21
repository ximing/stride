---
paths:
  - "apps/desktop/src/ui/**/*"
  - "apps/desktop/src/editor/**/*.tsx"
  - "apps/desktop/src/editor/**/*.css"
  - "apps/desktop/src/dev/**/*"
  - "apps/desktop/src/styles/**/*.css"
  - "apps/desktop/src/*.tsx"
  - "apps/desktop/src/*.css"
---

# UI 设计系统与组件规范

## 视觉与 Token 原则

- **语义化 Token 优先**：所有颜色、边框、阴影、圆角和间距必须使用 `apps/desktop/src/ui/tokens.css` 中的 `--sd-*` 变量（如 `--sd-bg`、`--sd-bg-elevated`、`--sd-fg`、`--sd-muted`、`--sd-border`、`--sd-accent`）。**严禁在组件 CSS 中硬编码颜色字面量**，确保 Light / Dark 主题切换一致。
- **字体双声部**：UI 界面使用无衬线字体（Avenir Next / system sans）；衬线字体（Iowan Old Style / system serif）仅用于笔记标题与笔记正文。
- **样式作用域**：基础组件类名统一使用 `sd-` 前缀；避免为新组件编写全局标签选择器（element selectors）。
- **动效与无障碍**：仅对 `opacity` 和 `transform` 做过渡动画，且必须尊重 `prefers-reduced-motion`；所有可交互控件需具备清晰的 `:focus-visible` 焦点环（2px accent ring + 2px offset）。

## 共享原语契约（`apps/desktop/src/ui/primitives/`）

原语、壳层和业务面板放在哪个目录，见 `apps/desktop/src/ui/CLAUDE.md`。原语不引用业务 Service，也不引用业务面板。

- **Button / IconButton**（`ui/primitives/button.tsx`）：使用 `tone="primary" | "secondary" | "quiet" | "danger"` 与 `size="sm" | "md" | "lg"`；纯图标按钮必须使用 `IconButton` 并传入无障碍 `label`。
- **Select**（`ui/primitives/select.tsx`）：产品 UI 中必须使用封装自 Radix 的 `Select` 组件，**禁止直接使用原生 `<select>`**。
- **Tabs**（`ui/primitives/tabs.tsx`）：使用 `Tabs`、`TabsList`、`TabsTrigger`、`TabsContent` 封装，保持 `sd-tabs*` 样式与键盘导航一致。
- **Modal / Menu / Toast / Tooltip**：必须复用现有 Radix 封装（`ui/primitives/modal.tsx`、`ui/primitives/menu.tsx`、`ui/primitives/toast.tsx`、`ui/primitives/tooltip.tsx`），**严禁调用 `window.alert`、`window.prompt` 或 `window.confirm`**。
- **Icons**（`ui/primitives/icon.tsx`）：统一从 `lucide-react` 引入图标并通过 `Mark` 组件渲染（常规控件 16px，紧凑/状态栏 14px，空态 18–20px）。**禁止使用 `+`、`×`、`▸`、`▾`、`✓` 或 emoji 充当独立 UI 图标**。
- **样式入口**：`ui/tokens.css` 是 `--sd-*` 的唯一来源。`ui/primitives.css`、`ui/shell.css`、`ui/panels.css`、`ui/overlays.css`、`src/styles.css`、`editor/chrome.css` 只做 `@import`。样式与组件放在同一目录：壳层在 `ui/shell/`，业务面板在各自功能目录，编辑器 chrome 在 `editor/chrome/`，原语在 `ui/primitives/`。`src/styles/` 只保留全局基础和栏布局网格。
- **测试稳定性**：修改已有组件或面板时，保持既有的 `data-testid` 属性、虚拟列表行高及键盘快捷键行为不变。
