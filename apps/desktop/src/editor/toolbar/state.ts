import type { Editor } from '@tiptap/core'

export const TEXT_COLORS = [
  { id: 'vermilion', value: '#b3402a' },
  { id: 'ochre', value: '#9a6232' },
  { id: 'green', value: '#2f7d4a' },
  { id: 'blue', value: '#2a5f9e' },
  { id: 'purple', value: '#6a4c93' },
  { id: 'ink', value: '#221d16' },
  { id: 'gray', value: '#6f675c' },
] as const

export const BACKGROUND_COLORS = [
  { id: 'yellow', value: '#f6e7a8' },
  { id: 'green', value: '#d7efd4' },
  { id: 'blue', value: '#d6e6f7' },
  { id: 'pink', value: '#f8d6d0' },
  { id: 'purple', value: '#e7dff6' },
  { id: 'gray', value: '#ece7df' },
] as const

export type BarState = {
  bold: boolean
  italic: boolean
  strike: boolean
  subscript: boolean
  superscript: boolean
  bullet: boolean
  ordered: boolean
  task: boolean
  quote: boolean
  link: boolean
  highlight: boolean
  code: boolean
  codeBlock: boolean
  table: boolean
  canUndo: boolean
  canRedo: boolean
  heading: string
  align: 'left' | 'center' | 'right'
  fontSize: string
  color: string
  background: string
}

export const IDLE: BarState = {
  bold: false,
  italic: false,
  strike: false,
  subscript: false,
  superscript: false,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  link: false,
  highlight: false,
  code: false,
  codeBlock: false,
  table: false,
  canUndo: false,
  canRedo: false,
  heading: 'p',
  align: 'left',
  fontSize: '',
  color: '',
  background: '',
}

export function styleAttr(editor: Editor, key: 'color' | 'fontSize' | 'backgroundColor'): string {
  const value = editor.getAttributes('textStyle')[key]
  return typeof value === 'string' ? value : ''
}

export function barStateOf(editor: Editor): BarState {
  let heading = 'p'
  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    if (editor.isActive('heading', { level })) heading = String(level)
  }
  const align = editor.isActive({ textAlign: 'center' })
    ? 'center'
    : editor.isActive({ textAlign: 'right' })
      ? 'right'
      : 'left'
  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    strike: editor.isActive('strike'),
    subscript: editor.isActive('subscript'),
    superscript: editor.isActive('superscript'),
    bullet: editor.isActive('bulletList'),
    ordered: editor.isActive('orderedList'),
    task: editor.isActive('taskList'),
    quote: editor.isActive('blockquote'),
    link: editor.isActive('link'),
    highlight: editor.isActive('highlight'),
    code: editor.isActive('code'),
    codeBlock: editor.isActive('codeBlock'),
    table: editor.isActive('table'),
    canUndo: editor.can().chain().undo().run(),
    canRedo: editor.can().chain().redo().run(),
    heading,
    align,
    fontSize: styleAttr(editor, 'fontSize'),
    color: styleAttr(editor, 'color'),
    background: styleAttr(editor, 'backgroundColor'),
  }
}

export function keepSelection(event: { preventDefault: () => void }) {
  event.preventDefault()
}
