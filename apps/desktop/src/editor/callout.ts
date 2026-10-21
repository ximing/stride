import { Extension, InputRule, Node, mergeAttributes, type Editor } from '@tiptap/core'

const CALLOUT_KINDS = ['note', 'warning', 'tip'] as const

function nextCalloutKind(kind: unknown): (typeof CALLOUT_KINDS)[number] {
  const index = CALLOUT_KINDS.indexOf(kind as (typeof CALLOUT_KINDS)[number])
  const current = index >= 0 ? index : 0
  return CALLOUT_KINDS[(current + 1) % CALLOUT_KINDS.length] ?? 'note'
}

export function highlightInputRule() {
  return new InputRule({
    find: /==([^=]+)==$/,
    handler: ({ state, range, match }) => {
      const text = match[1]
      if (!text) return
      const mark = state.schema.marks.highlight
      if (!mark) return
      state.tr.insertText(text, range.from, range.to).addMark(range.from, range.from + text.length, mark.create())
    },
  })
}

export const highlightInputExtension = Extension.create({
  name: 'highlightInput',
  addInputRules() {
    return [highlightInputRule()]
  },
})

export const calloutSlashCommand = {
  id: 'callout',
  title: '提示块',
  keywords: 'callout 提示 警告',
  run(editor: Editor) {
    editor.commands.insertContent({
      type: 'callout',
      attrs: { kind: 'note' },
      content: [{ type: 'paragraph' }],
    })
  },
}

export const calloutNode = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (element) => element.getAttribute('data-kind') || 'note',
        renderHTML: (attributes) => ({
          'data-kind': attributes.kind,
        }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'callout' }), 0]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'callout-block'
      dom.setAttribute('data-callout', '')

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'callout-kind'
      button.dataset.testid = 'callout-kind'
      button.contentEditable = 'false'

      const content = document.createElement('div')

      const paint = (kind: unknown) => {
        const value = typeof kind === 'string' && kind ? kind : 'note'
        dom.setAttribute('data-kind', value)
        button.textContent = value
      }
      paint(node.attrs.kind)

      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
      })
      button.addEventListener('click', (event) => {
        event.preventDefault()
        const pos = getPos()
        if (typeof pos !== 'number') return
        const current = editor.state.doc.nodeAt(pos)
        const kind = nextCalloutKind(current?.attrs.kind ?? node.attrs.kind)
        editor.commands.setNodeSelection(pos)
        editor.commands.updateAttributes('callout', { kind })
      })

      dom.append(button, content)

      return {
        dom,
        contentDOM: content,
        update: (updated) => {
          if (updated.type.name !== 'callout') return false
          paint(updated.attrs.kind)
          return true
        },
        stopEvent: (event) => event.target instanceof globalThis.Node && button.contains(event.target),
        ignoreMutation: (mutation) => !content.contains(mutation.target),
      }
    }
  },
})
