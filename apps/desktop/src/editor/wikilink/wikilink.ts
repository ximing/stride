import { Extension, InputRule, Node, PasteRule, mergeAttributes, type Editor, type Range } from '@tiptap/core'
import type { NodeType } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ReactRenderer } from '@tiptap/react'
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion'
import { isArchived, plainWikilinks, splitWikilinkText } from '@stride/core/note'
import { WikilinkMenu, type WikilinkMenuHandle, type WikilinkMenuItem } from './wikilink-menu'

const MAX_NOTES = 8

const wikilinkSuggestKey = new PluginKey('wikilinkSuggestion')

export type WikilinkSourceNote = {
  id: string
  title: string
  type?: string
  properties?: Record<string, unknown>
}

export type WikilinkClickAction = { type: 'select'; id: string } | { type: 'create'; title: string }

function archived(note: WikilinkSourceNote): boolean {
  if (!note.properties) return false
  return isArchived({ properties: note.properties })
}

function linkable(notes: readonly WikilinkSourceNote[]): WikilinkSourceNote[] {
  return notes.filter((note) => note.type !== 'Type' && !archived(note))
}

export function filterWikilinkNotes(notes: readonly WikilinkSourceNote[], query: string): WikilinkMenuItem[] {
  const target = splitWikilinkText(query.endsWith(']]') ? query.slice(0, -2) : query).target
  const needle = target.toLowerCase()
  const pool = linkable(notes)
  const matched = pool.filter((note) => note.title.toLowerCase().includes(needle)).slice(0, MAX_NOTES)
  const items: WikilinkMenuItem[] = matched.map((note) => ({ kind: 'note', id: note.id, title: note.title }))
  const exact = needle.length > 0 && pool.some((note) => note.title.trim().toLowerCase() === needle)
  if (needle && !exact) items.push({ kind: 'create', title: target })
  return items
}

export function resolveWikilinkClick(notes: readonly WikilinkSourceNote[], target: string): WikilinkClickAction {
  const match = linkable(notes).find((note) => note.title === target)
  if (match) return { type: 'select', id: match.id }
  return { type: 'create', title: target }
}

/**
 * Wikilink node at a document position (direct hit or the node ending at pos),
 * mirroring the click plugin's hit test. Used by the editor context menu.
 */
export function wikilinkAt(editor: Editor, pos: number): { target: string; alias: string } | null {
  const { doc } = editor.state
  const direct = doc.nodeAt(pos)
  const before = pos > 0 ? doc.nodeAt(pos - 1) : null
  const node = direct?.type.name === 'wikilink' ? direct : before?.type.name === 'wikilink' ? before : null
  if (!node) return null
  const target = typeof node.attrs.target === 'string' ? node.attrs.target.trim() : ''
  if (!target) return null
  const alias = typeof node.attrs.alias === 'string' ? node.attrs.alias : ''
  return { target, alias }
}

export function runWikilinkCommand(editor: Editor, range: Range, target: string, alias = ''): boolean {
  const title = target.trim()
  const label = alias.trim()
  if (!title) return false
  const attrs = label ? { target: title, alias: label } : { target: title }
  return editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent({ type: 'wikilink', attrs })
    .run()
}

/** Completion uses the chosen title as the target. A typed `|alias` stays on the alias. */
export function applyWikilinkSuggestion(editor: Editor, range: Range, title: string): boolean {
  const typed = editor.state.doc.textBetween(range.from, range.to, '\n', '\0')
  let inner = typed.startsWith('[[') ? typed.slice(2) : typed
  if (inner.endsWith(']]')) inner = inner.slice(0, -2)
  return runWikilinkCommand(editor, range, title, splitWikilinkText(inner).alias)
}

function placeMenu(renderer: ReactRenderer | null, props: { clientRect?: (() => DOMRect | null) | null }) {
  const root = renderer?.element
  if (!root) return
  const menu = root.matches('[data-testid="wikilink-menu"]')
    ? root
    : root.querySelector<HTMLElement>('[data-testid="wikilink-menu"]')
  if (!menu) return
  let rect: DOMRect | null = null
  try {
    rect = props.clientRect?.() ?? null
  } catch {
    rect = null
  }
  if (!rect) return
  menu.style.left = `${rect.left}px`
  menu.style.top = `${rect.bottom + 4}px`
}

function renderWikilinkMenu() {
  let renderer: ReactRenderer<WikilinkMenuHandle> | null = null

  return {
    onStart: (props: SuggestionProps<WikilinkMenuItem, WikilinkMenuItem>) => {
      renderer = new ReactRenderer(WikilinkMenu, {
        editor: props.editor,
        props,
      })
      document.body.appendChild(renderer.element)
      placeMenu(renderer, props)
    },
    onUpdate: (props: SuggestionProps<WikilinkMenuItem, WikilinkMenuItem>) => {
      renderer?.updateProps(props)
      placeMenu(renderer, props)
    },
    onKeyDown: (props: { event: KeyboardEvent }) => {
      if (props.event.key === 'Escape' || props.event.key === 'Esc') return false
      return renderer?.ref?.onKeyDown(props) ?? false
    },
    onExit: () => {
      renderer?.destroy()
      renderer?.element.remove()
      renderer = null
    },
  }
}

export function createWikilinkSuggestion(getNotes: () => { id: string; title: string }[]) {
  return {
    pluginKey: wikilinkSuggestKey,
    char: '[[',
    allowSpaces: true,
    items: ({ query }: { query: string }) => filterWikilinkNotes(getNotes(), query),
    command: ({ editor, range, props }: { editor: Editor; range: Range; props: WikilinkMenuItem }) => {
      applyWikilinkSuggestion(editor, range, props.title)
    },
    render: renderWikilinkMenu,
  }
}

export function createWikilinkSuggestionExtension(getNotes: () => { id: string; title: string }[]) {
  return Extension.create({
    name: 'wikilinkSuggestion',
    addProseMirrorPlugins() {
      return [
        Suggestion<WikilinkMenuItem, WikilinkMenuItem>({
          editor: this.editor,
          ...createWikilinkSuggestion(getNotes),
        }),
      ]
    },
  })
}

function wikilinkLabel(target: string, alias: string): string {
  return alias ? `[[${target}|${alias}]]` : `[[${target}]]`
}

function closedWikilink(text: string): { index: number; text: string; data: { target: string; alias: string } } | null {
  const link = plainWikilinks(text).at(-1)
  if (!link || link.end !== text.length) return null
  return {
    index: link.start,
    text: text.slice(link.start, link.end),
    data: { target: link.target, alias: link.alias },
  }
}

function pastedWikilinks(text: string): { index: number; text: string; data: { target: string; alias: string } }[] {
  return plainWikilinks(text).map((link) => ({
    index: link.start,
    text: text.slice(link.start, link.end),
    data: { target: link.target, alias: link.alias },
  }))
}

function writeWikilink(nodeType: NodeType, state: EditorState, range: Range, target: string, alias: string): void | null {
  const title = target.trim()
  if (!title) return null
  const label = alias.trim()
  const attrs = label ? { target: title, alias: label } : { target: title }
  state.tr.replaceWith(range.from, range.to, nodeType.create(attrs))
}

export function createWikilinkNode(options: {
  getNotes: () => { id: string; title: string }[]
  onOpen: (target: string) => void
}) {
  return Node.create({
    name: 'wikilink',
    group: 'inline',
    inline: true,
    atom: true,
    addAttributes() {
      return {
        target: {
          default: '',
          parseHTML: (element) => element.getAttribute('data-wikilink') ?? '',
          renderHTML: (attributes) => {
            const target = typeof attributes.target === 'string' ? attributes.target : ''
            if (!target) return {}
            return { 'data-wikilink': target }
          },
        },
        alias: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-alias') || null,
          renderHTML: (attributes) => {
            if (typeof attributes.alias !== 'string' || !attributes.alias) return {}
            return { 'data-alias': attributes.alias }
          },
        },
      }
    },
    parseHTML() {
      return [{ tag: 'span[data-wikilink]' }]
    },
    renderHTML({ node, HTMLAttributes }) {
      const target = typeof node.attrs.target === 'string' ? node.attrs.target : ''
      const alias = typeof node.attrs.alias === 'string' ? node.attrs.alias : ''
      return ['span', mergeAttributes(HTMLAttributes, { class: 'wikilink' }), wikilinkLabel(target, alias)]
    },
    addInputRules() {
      const nodeType = this.type
      return [
        new InputRule({
          find: (text) => closedWikilink(text),
          handler: ({ state, range, match }) => {
            const data = match.data as { target?: string; alias?: string } | undefined
            writeWikilink(nodeType, state, range, data?.target ?? '', data?.alias ?? '')
          },
        }),
      ]
    },
    addPasteRules() {
      const nodeType = this.type
      return [
        new PasteRule({
          find: (text) => pastedWikilinks(text),
          handler: ({ state, range, match }) => {
            const data = match.data as { target?: string; alias?: string } | undefined
            writeWikilink(nodeType, state, range, data?.target ?? '', data?.alias ?? '')
          },
        }),
      ]
    },
    addProseMirrorPlugins() {
      const getNotes = options.getNotes
      const onOpen = options.onOpen
      return [
        new Plugin({
          key: new PluginKey('wikilinkResolve'),
          props: {
            decorations(state) {
              const titles = new Set(getNotes().map((note) => note.title))
              const decorations: Decoration[] = []
              state.doc.descendants((node, pos) => {
                if (node.type.name !== 'wikilink') return
                const target = typeof node.attrs.target === 'string' ? node.attrs.target : ''
                const resolved = target.length > 0 && titles.has(target)
                decorations.push(Decoration.node(pos, pos + node.nodeSize, {
                  class: resolved ? 'wikilink is-resolved' : 'wikilink is-unresolved',
                }))
              })
              if (decorations.length === 0) return null
              return DecorationSet.create(state.doc, decorations)
            },
          },
        }),
        new Plugin({
          key: new PluginKey('wikilinkClick'),
          props: {
            handleClick(view, pos) {
              const { doc } = view.state
              const direct = doc.nodeAt(pos)
              const before = pos > 0 ? doc.nodeAt(pos - 1) : null
              const node = direct?.type.name === 'wikilink' ? direct : before?.type.name === 'wikilink' ? before : null
              if (!node) return false
              const target = typeof node.attrs.target === 'string' ? node.attrs.target.trim() : ''
              if (!target) return true
              onOpen(target)
              return true
            },
          },
        }),
      ]
    },
  })
}
