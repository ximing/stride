import { Extension, type Editor } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import { t } from '../../i18n'
import { renderSlashMenu } from './slash-menu'

export type SlashCommand = {
  id: string
  title: string
  keywords: string
  run: (editor: Editor) => void
}

export const slashCommands: SlashCommand[] = []

export function registerSlashCommand(command: SlashCommand) {
  const index = slashCommands.findIndex((item) => item.id === command.id)
  if (index >= 0) slashCommands[index] = command
  else slashCommands.push(command)
}

export function filterSlashCommands(query: string): SlashCommand[] {
  const needle = query.toLowerCase()
  return slashCommands.filter((item) => {
    const en = t(`editor.slash.${item.id}`, { lng: 'en' })
    const zh = t(`editor.slash.${item.id}`, { lng: 'zh' })
    return `${item.title} ${item.keywords} ${en} ${zh}`.toLowerCase().includes(needle)
  })
}

export function moveSlashSelection(index: number, direction: 'up' | 'down', length: number): number {
  if (length <= 0) return 0
  const step = direction === 'down' ? 1 : -1
  return (index + step + length) % length
}

registerSlashCommand({
  id: 'h2',
  title: 'Heading 2',
  keywords: 'h2 heading 标题',
  run: (editor) => {
    editor.commands.toggleHeading({ level: 2 })
  },
})

registerSlashCommand({
  id: 'h3',
  title: 'Heading 3',
  keywords: 'h3 heading 标题',
  run: (editor) => {
    editor.commands.toggleHeading({ level: 3 })
  },
})

registerSlashCommand({
  id: 'bullet',
  title: 'Bulleted list',
  keywords: 'bullet list ul 无序 列表',
  run: (editor) => {
    editor.commands.toggleBulletList()
  },
})

registerSlashCommand({
  id: 'ordered',
  title: 'Numbered list',
  keywords: 'ordered list ol 有序 列表',
  run: (editor) => {
    editor.commands.toggleOrderedList()
  },
})

registerSlashCommand({
  id: 'quote',
  title: 'Quote',
  keywords: 'quote blockquote 引用',
  run: (editor) => {
    editor.commands.toggleBlockquote()
  },
})

registerSlashCommand({
  id: 'code',
  title: 'Code block',
  keywords: 'code block 代码 代码块',
  run: (editor) => {
    editor.commands.toggleCodeBlock()
  },
})

registerSlashCommand({
  id: 'hr',
  title: 'Divider',
  keywords: 'hr horizontal rule divider 分隔线 分隔',
  run: (editor) => {
    editor.commands.setHorizontalRule()
  },
})

export const slashPluginKey = new PluginKey('slashMenu')

export const slashMenu = Extension.create({
  name: 'slashMenu',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      Suggestion<SlashCommand, SlashCommand>({
        pluginKey: slashPluginKey,
        editor,
        char: '/',
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          if (!$from.parent.isTextblock) return false
          if ($from.parentOffset === 0) return true
          const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, '\n', '\0')
          return /\s/.test(before)
        },
        items: ({ query }) => filterSlashCommands(query),
        command: (props) => {
          props.editor.chain().deleteRange(props.range).run()
          props.props.run(props.editor)
        },
        render: renderSlashMenu,
      }),
    ]
  },
})
