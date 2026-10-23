import { Service } from '@rabjs/react'
import { Extension, type Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { closeOverlays } from '../../services/platform/overlays'
import { applyHitsReplace, findKeywordHits, type FindHit } from './find-hits'

const LIST_OVERLAYS = ['commandPalette', 'quickOpen', 'searchPanel'] as const

export type TextMatch = { from: number; to: number }

type HighlightMeta = { from: number; to: number } | null

const findHighlightKey = new PluginKey<DecorationSet>('findHighlight')

// Cmd/Ctrl+Shift+F is the vault search panel. Alt and Shift never open in-note find.
export function isFindShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.shiftKey || event.altKey) return false
  if (!event.metaKey && !event.ctrlKey) return false
  return event.key === 'f' || event.key === 'F'
}

/** Case-insensitive unless `caseSensitive` is set. Atoms (wikilink) still break a run. */
export function findTextMatches(doc: PmNode, query: string, caseSensitive = false): TextMatch[] {
  if (!query) return []
  return findKeywordHits(doc, query, caseSensitive).map((hit) => ({ from: hit.from, to: hit.to }))
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
  const node = doc.nodeAt(from)
  if (node?.isAtom && from + node.nodeSize === to) {
    if (node.isInline) return [Decoration.inline(from, to, { class: 'find-hit' })]
    return [Decoration.node(from, to, { class: 'find-hit' })]
  }
  const decorations: Decoration[] = []
  doc.nodesBetween(from, to, (child, pos) => {
    if (!child.isText) return
    const start = Math.max(from, pos)
    const end = Math.min(to, pos + child.nodeSize)
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

function selectRange(editor: Editor, from: number, to: number): void {
  const tr = editor.state.tr.setMeta('addToHistory', false)
  const node = tr.doc.nodeAt(from)
  if (node?.isAtom && from + node.nodeSize === to) tr.setSelection(NodeSelection.create(tr.doc, from))
  else tr.setSelection(TextSelection.create(tr.doc, from, Math.max(from, to)))
  tr.setMeta(findHighlightKey, to > from ? { from, to } : null)
  tr.scrollIntoView()
  editor.view.dispatch(tr)
}

export function selectMatch(editor: Editor, match: TextMatch): void {
  if (editor.isDestroyed) return
  const from = clampPos(editor.state.doc, match.from)
  const to = clampPos(editor.state.doc, match.to)
  selectRange(editor, Math.min(from, to), Math.max(from, to))
}

function placeReplaced(tr: ReturnType<Editor['state']['tr']['setMeta']>, hit: FindHit, replacement: string) {
  if (hit.kind === 'attr') {
    const node = tr.doc.nodeAt(hit.from)
    if (!node) return
    tr.setSelection(NodeSelection.create(tr.doc, hit.from))
    tr.setMeta(findHighlightKey, { from: hit.from, to: hit.from + node.nodeSize })
    return
  }
  const from = hit.from
  const to = from + replacement.length
  if (to > from) tr.setSelection(TextSelection.create(tr.doc, from, to))
  else tr.setSelection(TextSelection.create(tr.doc, clampPos(tr.doc, from)))
  tr.setMeta(findHighlightKey, to > from ? { from, to } : null)
}

// One transaction so autosave and undo see a single edit. Later matches go first so earlier positions stay valid.
// The replacement keeps the marks on the matched text. Text outside the match is left alone.
function replaceHits(editor: Editor, hits: readonly FindHit[], replacement: string): boolean {
  if (hits.length === 0 || editor.isDestroyed) return false
  const ordered = [...hits].sort((left, right) => left.from - right.from || left.attrFrom - right.attrFrom)
  const tr = editor.state.tr
  applyHitsReplace(tr, ordered, replacement)
  const first = ordered[0]
  if (!first) return false
  placeReplaced(tr, first, replacement)
  tr.scrollIntoView()
  editor.view.dispatch(tr)
  return true
}

export function replaceOneMatch(
  editor: Editor,
  query: string,
  index: number,
  replacement: string,
  caseSensitive = false,
): boolean {
  if (!query || editor.isDestroyed) return false
  const hits = findKeywordHits(editor.state.doc, query, caseSensitive)
  if (hits.length === 0) return false
  const hit = hits[mod(index, hits.length)]
  if (!hit) return false
  return replaceHits(editor, [hit], replacement)
}

export function replaceAllMatches(
  editor: Editor,
  query: string,
  replacement: string,
  caseSensitive = false,
): number {
  if (!query || editor.isDestroyed) return 0
  const hits = findKeywordHits(editor.state.doc, query, caseSensitive)
  if (hits.length === 0) return 0
  return replaceHits(editor, hits, replacement) ? hits.length : 0
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
  caseSensitive = false

  show() {
    // Same mutual exclusion as the list panels. Settings is not in this list:
    // opening find does not close it, and a settings dialog that is still open
    // keeps local keys (see overlay-keys.ts).
    closeOverlays(LIST_OVERLAYS)
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

  toggleCase() {
    this.caseSensitive = !this.caseSensitive
    this.index = 0
  }

  bump() {
    this.revision += 1
  }
}
