import { Service } from '@rabjs/react'
import { Extension, type Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export type TextMatch = { from: number; to: number }

type HighlightMeta = { from: number; to: number } | null

const findHighlightKey = new PluginKey<DecorationSet>('findHighlight')

// Cmd/Ctrl+Shift+F is the vault search panel. Alt and Shift never open in-note find.
export function isFindShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.shiftKey || event.altKey) return false
  if (!event.metaKey && !event.ctrlKey) return false
  return event.key === 'f' || event.key === 'F'
}

type TextRun = { text: string; positions: number[] }

// Adjacent text nodes stay one run. A block or atom between them is not a character.
function textRuns(doc: PmNode): TextRun[] {
  const runs: TextRun[] = []
  let run: TextRun | null = null
  let end = -1
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const text = node.text ?? ''
    if (!text) return false
    if (!run || end !== pos) {
      run = { text: '', positions: [] }
      runs.push(run)
    }
    for (let index = 0; index < text.length; index += 1) {
      run.text += text[index] ?? ''
      run.positions.push(pos + index)
    }
    end = pos + text.length
    return false
  })
  return runs
}

export function findTextMatches(doc: PmNode, query: string): TextMatch[] {
  if (!query) return []
  const matches: TextMatch[] = []
  for (const run of textRuns(doc)) {
    let cursor = 0
    while (cursor <= run.text.length - query.length) {
      const found = run.text.indexOf(query, cursor)
      if (found < 0) break
      const from = run.positions[found]
      const last = run.positions[found + query.length - 1]
      if (from === undefined || last === undefined) break
      matches.push({ from, to: last + 1 })
      cursor = found + query.length
    }
  }
  return matches
}

function clampPos(doc: PmNode, pos: number): number {
  return Math.max(0, Math.min(pos, doc.content.size))
}

function mod(index: number, length: number): number {
  if (length <= 0) return 0
  return ((index % length) + length) % length
}

function highlightDecorations(doc: PmNode, from: number, to: number): Decoration[] {
  if (to <= from) return []
  const decorations: Decoration[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return
    const start = Math.max(from, pos)
    const end = Math.min(to, pos + node.nodeSize)
    if (end > start) decorations.push(Decoration.inline(start, end, { class: 'find-hit' }))
  })
  return decorations
}

function findHighlightPlugin() {
  return new Plugin<DecorationSet>({
    key: findHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const meta = tr.getMeta(findHighlightKey) as HighlightMeta | undefined
        if (meta === null) return DecorationSet.empty
        if (meta) {
          const decorations = highlightDecorations(tr.doc, meta.from, meta.to)
          return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(tr.doc, decorations)
        }
        return old.map(tr.mapping, tr.doc)
      },
    },
    props: {
      decorations(state) {
        return findHighlightKey.getState(state) ?? DecorationSet.empty
      },
    },
  })
}

export const findHighlightExtension = Extension.create({
  name: 'findHighlight',
  addProseMirrorPlugins() {
    return [findHighlightPlugin()]
  },
})

export function clearFindHighlight(editor: Editor): void {
  if (editor.isDestroyed) return
  const current = findHighlightKey.getState(editor.state)
  if (!current || current.find().length === 0) return
  editor.view.dispatch(
    editor.state.tr.setMeta(findHighlightKey, null).setMeta('addToHistory', false),
  )
}

export function selectMatch(editor: Editor, match: TextMatch): void {
  if (editor.isDestroyed) return
  const from = clampPos(editor.state.doc, match.from)
  const to = clampPos(editor.state.doc, match.to)
  const anchor = Math.min(from, to)
  const head = Math.max(from, to)
  const tr = editor.state.tr.setMeta('addToHistory', false)
  tr.setSelection(TextSelection.create(tr.doc, anchor, head))
  tr.setMeta(findHighlightKey, head > anchor ? { from: anchor, to: head } : null)
  tr.scrollIntoView()
  editor.view.dispatch(tr)
}

// One transaction so autosave and undo see a single edit. Later matches go first so earlier positions stay valid.
export function replaceMatches(editor: Editor, matches: readonly TextMatch[], replacement: string): boolean {
  if (matches.length === 0 || editor.isDestroyed) return false
  const ordered = [...matches].sort((left, right) => left.from - right.from)
  const tr = editor.state.tr
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const match = ordered[index]
    if (!match) continue
    tr.insertText(replacement, match.from, match.to)
  }
  const first = ordered[0]
  if (!first) return false
  const anchor = clampPos(tr.doc, first.from)
  const head = clampPos(tr.doc, first.from + replacement.length)
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  tr.setSelection(TextSelection.create(tr.doc, from, to))
  tr.setMeta(findHighlightKey, to > from ? { from, to } : null)
  tr.scrollIntoView()
  editor.view.dispatch(tr)
  return true
}

export function replaceOneMatch(editor: Editor, query: string, index: number, replacement: string): boolean {
  if (!query || editor.isDestroyed) return false
  const matches = findTextMatches(editor.state.doc, query)
  if (matches.length === 0) return false
  const match = matches[mod(index, matches.length)]
  if (!match) return false
  return replaceMatches(editor, [match], replacement)
}

export function replaceAllMatches(editor: Editor, query: string, replacement: string): number {
  if (!query || editor.isDestroyed) return 0
  const matches = findTextMatches(editor.state.doc, query)
  if (matches.length === 0) return 0
  return replaceMatches(editor, matches, replacement) ? matches.length : 0
}

export function matchIndex(index: number, count: number): number {
  return mod(index, count)
}

export class FindService extends Service {
  open = false
  query = ''
  replacement = ''
  index = 0
  revision = 0

  show() {
    this.open = true
  }

  close() {
    this.open = false
  }

  setQuery(value: string) {
    this.query = value
    this.index = 0
  }

  setReplacement(value: string) {
    this.replacement = value
  }

  setIndex(index: number) {
    this.index = index
  }

  bump() {
    this.revision += 1
  }
}
