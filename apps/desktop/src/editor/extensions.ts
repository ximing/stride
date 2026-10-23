import type { FileSystemBackend } from '@stride/platform'
import type { Editor } from '@tiptap/core'
import Highlight from '@tiptap/extension-highlight'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyleKit } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'
import 'katex/dist/katex.min.css'
import { t } from '../i18n'
import { codeBlockExtension } from './code/codeblock'
import { calloutNode, calloutSlashCommand, highlightInputExtension } from './callout/callout'
import { externalLinkOpen } from './link/external-link-plugin'
import { findHighlightExtension } from './find/find'
import { createImageExtension, imageSlashCommand } from './image/image'
import { createDocMathExtensions } from './math/math'
import { MermaidBlock } from './mermaid/mermaid-block'
import { mermaidBlockNodeView } from './mermaid/mermaid-block-view'
import { insertMermaid } from './mermaid/mermaid-insert'
import { createPasteExtension } from './paste/paste-plugin'
import { registerSlashCommand, slashMenu } from './slash/slash'
import { tableExtensions, tableSlashCommand } from './table/table'
import { createTaskExtensions, taskSlashCommand } from './task/task'
import { createWikilinkNode, createWikilinkSuggestionExtension } from './wikilink/wikilink'

registerSlashCommand(taskSlashCommand)
registerSlashCommand(tableSlashCommand)
registerSlashCommand(calloutSlashCommand)
registerSlashCommand(imageSlashCommand)

// The toolbar owns the formula prompt. Slash math calls this instead of a window event.
let openMathPrompt: (() => void) | null = null

export function setMathPromptOpener(opener: (() => void) | null): void {
  openMathPrompt = opener
}

registerSlashCommand({
  id: 'math',
  title: 'Math',
  keywords: 'math latex katex 公式 数学',
  run: () => {
    openMathPrompt?.()
  },
})
registerSlashCommand({
  id: 'mermaid',
  title: 'Mermaid',
  keywords: 'mermaid diagram 流程图 图',
  run: (editor) => {
    insertMermaid(editor)
  },
})

// Mod-, is the app settings chord. These marks stay on the toolbar only.
const DocSubscript = Subscript.extend({
  addKeyboardShortcuts() {
    return {}
  },
})

const DocSuperscript = Superscript.extend({
  addKeyboardShortcuts() {
    return {}
  },
})

// Link's default priority keeps color and font size inside the anchor.
// No Mod-k: the command palette owns that chord app-wide.
const DocLink = Link.extend({
  priority: 1000,
  addKeyboardShortcuts() {
    return {}
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  enableClickSelection: true,
  HTMLAttributes: {},
})

const mermaidBlock = MermaidBlock.extend({
  addNodeView() {
    return mermaidBlockNodeView
  },
})

export type FormatName =
  | 'bold'
  | 'italic'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'quote'
  | 'strike'
  | 'code'
  | 'codeBlock'
  | 'highlight'
  | 'hr'

// The editor keymap (StarterKit & friends) owns editing chords only. It must
// never bind a chord the app command manifest owns — the manifest dispatcher
// listens on window capture and would shadow the editor binding. That is why
// there is no Mod-k link shortcut here: Mod+K is the command palette app-wide
// (T6.2), and the link form opens via the toolbar instead.
export function createEditorExtensions(options: {
  getNotes?: () => { id: string; title: string }[]
  onOpen?: (target: string) => void
  getFs?: () => FileSystemBackend | null
} = {}) {
  // StarterKit already registers Link. A second copy clashes on the name.
  // trailingNode stays on.
  const getNotes = options.getNotes ?? (() => [])
  const onOpen = options.onOpen ?? (() => {})

  const getFs = options.getFs ?? (() => null)

  return [
    StarterKit.configure({
      link: false,
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    DocLink,
    TextStyleKit.configure({ fontFamily: false, lineHeight: false }),
    TextAlign.configure({
      types: ['heading', 'paragraph', 'blockquote'],
      alignments: ['left', 'center', 'right'],
      defaultAlignment: null,
    }),
    DocSubscript,
    DocSuperscript,
    Highlight.configure({ multicolor: false }),
    Placeholder.configure({ placeholder: () => t('editor.placeholder') }),
    createWikilinkNode({ getNotes, onOpen }),
    createWikilinkSuggestionExtension(getNotes),
    ...createTaskExtensions(),
    slashMenu,
    ...tableExtensions(),
    calloutNode,
    highlightInputExtension,
    createImageExtension({ getFs }),
    codeBlockExtension,
    ...createDocMathExtensions(),
    mermaidBlock,
    externalLinkOpen,
    findHighlightExtension,
    createPasteExtension(getFs),
  ]
}

const FORMAT_MARKS = [
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'underline',
  'subscript',
  'superscript',
  'textStyle',
  'highlight',
] as const

const BLOCK_FORMATS = new Set([
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'codeBlock',
  'mermaid',
])

function ancestorHasBlockFormat(pos: Editor['state']['selection']['$from']): boolean {
  for (let depth = pos.depth; depth > 0; depth -= 1) {
    if (BLOCK_FORMATS.has(pos.node(depth).type.name)) return true
  }
  return false
}

function blockStructureActive(editor: Editor): boolean {
  const { selection } = editor.state
  if (ancestorHasBlockFormat(selection.$from) || ancestorHasBlockFormat(selection.$to)) return true
  if (selection.empty) return false
  let found = false
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (BLOCK_FORMATS.has(node.type.name)) found = true
  })
  return found
}

/** Clear marks on the selection, or the whole text block when the caret is empty. Block structure lifts only when one is active. */
export function clearFormatting(editor: Editor): boolean {
  const chain = editor.chain().focus()
  chain.command(({ tr, state }) => {
    const { selection } = state
    const ranges = selection.empty
      ? [{ from: selection.$from.start(), to: selection.$from.end() }]
      : selection.ranges.map((range) => ({ from: range.$from.pos, to: range.$to.pos }))
    for (const name of FORMAT_MARKS) {
      const type = state.schema.marks[name]
      if (!type) continue
      for (const range of ranges) {
        if (range.from < range.to) tr.removeMark(range.from, range.to, type)
      }
      tr.removeStoredMark(type)
    }
    return true
  })
  if (editor.isActive({ textAlign: 'center' }) || editor.isActive({ textAlign: 'right' })) {
    chain.unsetTextAlign()
  }
  if (blockStructureActive(editor)) chain.clearNodes()
  return chain.run()
}

export function runFormat(editor: Editor, name: FormatName): boolean {
  switch (name) {
    case 'bold':
      return editor.commands.toggleBold()
    case 'italic':
      return editor.commands.toggleItalic()
    case 'h2':
      return editor.commands.toggleHeading({ level: 2 })
    case 'h3':
      return editor.commands.toggleHeading({ level: 3 })
    case 'bullet':
      return editor.commands.toggleBulletList()
    case 'ordered':
      return editor.commands.toggleOrderedList()
    case 'task':
      return editor.commands.toggleTaskList()
    case 'quote':
      return editor.commands.toggleBlockquote()
    case 'strike':
      return editor.commands.toggleStrike()
    case 'code':
      return editor.commands.toggleCode()
    case 'codeBlock':
      return editor.commands.toggleCodeBlock()
    case 'highlight':
      return editor.commands.toggleHighlight()
    case 'hr':
      return editor.commands.setHorizontalRule()
    default:
      return false
  }
}

export function applyLink(editor: Editor, href: string): boolean {
  const url = href.trim()
  if (!url) return false
  const { empty, from } = editor.state.selection
  if (!empty) {
    return editor.chain().extendMarkRange('link').setLink({ href: url }).run()
  }
  if (!editor.can().setLink({ href: url })) return false
  return editor
    .chain()
    .insertContent(url)
    .setTextSelection({ from, to: from + url.length })
    .setLink({ href: url })
    .run()
}

export function unsetLink(editor: Editor): boolean {
  return editor.chain().extendMarkRange('link').unsetLink().run()
}
