---
paths:
  - "apps/desktop/src/services/**/*.ts"
  - "apps/desktop/src/services/**/*.tsx"
  - "apps/desktop/src/main.tsx"
  - "apps/desktop/src/app.tsx"
  - "apps/desktop/src/ui/**/*.tsx"
  - "apps/desktop/src/editor/**/*.tsx"
  - "apps/desktop/src/dev/**/*.tsx"
---

# `@rabjs/react` Service 状态管理与命令规范

## Service 定义与注册

- **类继承与响应式边界**：业务状态服务继承自 `@rabjs/react` 的 `Service`，按业务域放在 `apps/desktop/src/services/<域>/`（见 `apps/desktop/AGENTS.md`）。对于不需要深层代理的大对象、底层平台句柄或第三方实例（如 `FileSystemBackend`、`SearchBackend`、定时器句柄），使用 `raw()` 包裹以避免不必要的响应式开销与代理问题。
- **容器注册**：新增全局 Service 需在 `apps/desktop/src/main.tsx` 启动阶段通过 `register(MyService)` 注册；跨 Service 协作可通过 `resolve()` 或构造函数/属性关联获取。
- **领域下沉**：Service 负责前端状态编排、异步流程与 UI 面板联动；纯算法与数据格式逻辑（如双链计算、笔记序列化、Git 输出解析）应下沉到 `@stride/core` 并在 Service 中调用。

## React 组件消费模式

- **响应式订阅**：读取 Service 状态的 React 组件必须使用 `observer(function MyComponent() { ... })` 包裹，并通过 `useService(MyService)` 获取实例，使组件仅在所读字段变化时重渲染。
- **避免冗余局部状态**：跨面板共享的状态（如当前打开笔记、激活右侧面板、搜索词、主题、设置项）统一收敛在对应 Service 中，不要在多个组件间通过深层 props drilling 或重复 `useState` 维护两份状态。

## 命令与快捷键单一真相源

- 应用级命令与快捷键定义统一存放在 `apps/desktop/src/appCommandManifest.json`。
- 新增、重命名或修改快捷键时，必须同步更新 `appCommandManifest.json`、`services/commands/command.service.ts` 与 `services/commands/commands.ts`，并确保 `src/services/commands/command-matrix.test.ts` 测试通过，杜绝死绑定（dead bindings）或弹层焦点冲突。
