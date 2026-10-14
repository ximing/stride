import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core'
import Highlight from '@tiptap/extension-highlight'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { createTaskExtensions } from './task'

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

function createWikilink() {
  return Node.create({
    name: 'wikilink',
    group: 'inline',
    inline: true,
    atom: true,
    addAttributes() {
      return { target: { default: '' } }
    },
    parseHTML() {
      return [{ tag: 'span[data-wikilink]' }]
    },
    renderHTML({ HTMLAttributes }) {
      const target = String(HTMLAttributes.target || '')
      return ['span', mergeAttributes(HTMLAttributes, { 'data-wikilink': target, class: 'wikilink' }), `[[${target}]]`]
    },
  })
}

export function createEditorExtensions(options: { onModK: () => boolean }) {
  // StarterKit already registers Link. A second copy clashes on the name.
  // trailingNode stays on.
  const linkKeymap = Extension.create({
    name: 'linkKeymap',
    addKeyboardShortcuts() {
      return {
        'Mod-k': () => options.onModK(),
      }
    },
  })

  return [
    StarterKit.configure({ link: false }),
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: true,
      HTMLAttributes: {},
    }),
    Highlight.configure({ multicolor: false }),
    createWikilink(),
    linkKeymap,
    Placeholder.configure({ placeholder: 'Write in the vault…' }),
    ...createTaskExtensions(),
  ]
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
