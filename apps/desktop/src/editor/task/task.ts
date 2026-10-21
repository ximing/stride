import { mergeAttributes, type Editor } from '@tiptap/core'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'

export type TaskCountNode = {
  type?: string
  attrs?: Record<string, unknown> | null
  content?: TaskCountNode[] | null
}

export function taskProgress(node: TaskCountNode | null | undefined): { done: number; total: number } {
  let done = 0
  let total = 0
  const walk = (current: TaskCountNode | null | undefined) => {
    if (!current) return
    if (current.type === 'taskItem') {
      total += 1
      if (current.attrs?.checked === true) done += 1
    }
    current.content?.forEach(walk)
  }
  walk(node)
  return { done, total }
}

function paintProgress(progress: HTMLElement, node: { toJSON: () => TaskCountNode }) {
  const { done, total } = taskProgress(node.toJSON())
  progress.textContent = `${done}/${total}`
}

function createTaskList() {
  return TaskList.extend({
    addNodeView() {
      return ({ node, HTMLAttributes }) => {
        const dom = document.createElement('div')
        dom.className = 'task-list-block'

        const progress = document.createElement('span')
        progress.className = 'task-progress'
        progress.dataset.testid = 'task-progress'
        progress.contentEditable = 'false'

        const list = document.createElement('ul')
        const rendered = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
          'data-type': this.name,
        })
        for (const [key, value] of Object.entries(rendered)) {
          if (value == null) continue
          list.setAttribute(key, String(value))
        }

        paintProgress(progress, node)
        dom.append(progress, list)

        return {
          dom,
          contentDOM: list,
          update: (updated) => {
            if (updated.type.name !== this.name) return false
            paintProgress(progress, updated)
            return true
          },
          ignoreMutation: (mutation) => !list.contains(mutation.target),
        }
      }
    },
  })
}

export function createTaskExtensions() {
  return [createTaskList(), TaskItem.configure({ nested: true })]
}

export const taskSlashCommand = {
  id: 'task',
  title: 'Task list',
  keywords: 'task todo 任务 待办',
  run(editor: Editor) {
    editor.chain().focus().toggleTaskList().run()
  },
}
