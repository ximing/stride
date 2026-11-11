// Hover actions for a whole code block or table: copy, cut, and delete.
// The bar is positioned in the editor scroller's content coordinates so it
// stays on the block's left and pins inside the visible scrollport.

import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { copySelectionToClipboard } from '../menu/editor-clipboard'

export type BlockKind = 'codeBlock' | 'table'

export type BlockHit = {
  pos: number
  kind: BlockKind
  dom: HTMLElement
}

export type BlockBox = { top: number; left: number }

/** Collapsed square. Width matches `.editor-block-actions`; the open menu grows downward. */
export const BLOCK_ACTION_BAR = { width: 30, height: 30 }

const GAP = 2
const EDGE = 6

function isBlockKind(name: string): name is BlockKind {
  return name === 'codeBlock' || name === 'table'
}

function shellOf(target: Node): HTMLElement | null {
  const element = target instanceof Element ? target : target.parentElement
  if (!element) return null
  const shell = element.closest('.editor-code, .tableWrapper')
  return shell instanceof HTMLElement ? shell : null
}

function probePos(view: EditorView, target: Node, shell: HTMLElement): number | null {
  const candidates: Array<{ node: Node; offset: number }> = []
  if (target instanceof Element) candidates.push({ node: target, offset: 0 })
  else if (target.parentNode) {
    const offset = Array.prototype.indexOf.call(target.parentNode.childNodes, target)
    candidates.push({ node: target.parentNode, offset: Math.max(0, offset) })
  }
  const inner = shell.classList.contains('editor-code')
    ? shell.querySelector('code')
    : shell.querySelector('td, th')
  if (inner) candidates.push({ node: inner, offset: 0 })
  candidates.push({ node: shell, offset: 0 })
  for (const candidate of candidates) {
    try {
      return view.posAtDOM(candidate.node, candidate.offset)
    } catch {
      // A wrapper that is not a textblock still has another candidate.
    }
  }
  return null
}

function blockAtProbe(doc: ProseMirrorNode, probe: number): { pos: number; kind: BlockKind } | null {
  const clamped = Math.max(0, Math.min(probe, doc.content.size))
  const $pos = doc.resolve(clamped)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const name = $pos.node(depth).type.name
    if (isBlockKind(name)) return { pos: $pos.before(depth), kind: name }
  }
  const direct = doc.nodeAt(clamped)
  if (direct && isBlockKind(direct.type.name)) return { pos: clamped, kind: direct.type.name }
  return null
}

function blockByDom(view: EditorView, shell: HTMLElement): { pos: number; kind: BlockKind } | null {
  let found: { pos: number; kind: BlockKind } | null = null
  view.state.doc.descendants((node, pos) => {
    if (found) return false
    if (!isBlockKind(node.type.name)) return
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return
    if (dom === shell || dom.contains(shell) || shell.contains(dom)) {
      found = { pos, kind: node.type.name }
      return false
    }
  })
  return found
}

/** The code block or table that owns `target`, or null when the pointer is on other content. */
export function blockHitAt(view: EditorView, target: EventTarget | null): BlockHit | null {
  if (!(target instanceof Node) || !view.dom.contains(target)) return null
  const shell = shellOf(target)
  if (!shell || !view.dom.contains(shell)) return null
  const probe = probePos(view, target, shell)
  const fromProbe = probe === null ? null : blockAtProbe(view.state.doc, probe)
  const match = fromProbe && ownsShell(view, fromProbe.pos, shell) ? fromProbe : blockByDom(view, shell)
  if (!match) return null
  return { pos: match.pos, kind: match.kind, dom: shell }
}

function ownsShell(view: EditorView, pos: number, shell: HTMLElement): boolean {
  const dom = view.nodeDOM(pos)
  return dom instanceof HTMLElement && (dom === shell || dom.contains(shell) || shell.contains(dom))
}

function selectBlock(editor: Editor, pos: number): boolean {
  if (editor.isDestroyed) return false
  const node = editor.state.doc.nodeAt(pos)
  if (!node || !isBlockKind(node.type.name)) return false
  const tr = editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos))
  tr.setMeta('addToHistory', false)
  editor.view.dispatch(tr)
  return true
}

/** Copy the block as rich HTML plus plain text. A failed write leaves the document unchanged. */
export async function copyBlock(editor: Editor, pos: number): Promise<boolean> {
  if (!selectBlock(editor, pos)) return false
  try {
    return await copySelectionToClipboard(editor)
  } catch {
    return false
  }
}

/** Copy the block, then delete it. A failed copy keeps the block. */
export async function cutBlock(editor: Editor, pos: number): Promise<boolean> {
  if (!editor.isEditable || editor.isDestroyed) return false
  const copied = await copyBlock(editor, pos)
  if (!copied || editor.isDestroyed || !editor.isEditable) return false
  // The clipboard write yields. Focus can put the caret back in a cell, so
  // select the block again instead of trusting the selection from the copy.
  return deleteBlock(editor, pos)
}

export function deleteBlock(editor: Editor, pos: number): boolean {
  if (!editor.isEditable || editor.isDestroyed) return false
  const node = editor.state.doc.nodeAt(pos)
  if (!node || !isBlockKind(node.type.name)) return false
  return editor.chain().focus().setNodeSelection(pos).deleteSelection().run()
}

/**
 * Content-box position of the action bar. `top` pins to the block, then to the
 * visible scrollport once the block's top has scrolled away. Returns null when
 * the block is outside the scrollport.
 */
export function placeBlockActions(args: {
  block: { top: number; left: number; bottom: number }
  frame: { top: number; left: number }
  scrollTop: number
  scrollLeft: number
  clientTop: number
  clientLeft: number
  clientHeight: number
  barWidth?: number
  barHeight?: number
}): BlockBox | null {
  const barWidth = args.barWidth ?? BLOCK_ACTION_BAR.width
  const blockTop = args.block.top - args.frame.top - args.clientTop + args.scrollTop
  const blockBottom = args.block.bottom - args.frame.top - args.clientTop + args.scrollTop
  const blockLeft = args.block.left - args.frame.left - args.clientLeft + args.scrollLeft
  const viewTop = args.scrollTop
  const viewBottom = args.scrollTop + args.clientHeight
  if (blockBottom <= viewTop || blockTop >= viewBottom) return null

  let left = blockLeft - barWidth - GAP
  // The note column can sit flush with the scroller padding. Drop the gap
  // before overlapping the block, and never slide the bar into the text.
  if (left < args.scrollLeft) left = Math.max(args.scrollLeft, blockLeft - barWidth)

  let top = blockTop
  const visibleTop = viewTop + EDGE
  if (top < visibleTop) top = visibleTop
  const blockLimit = blockBottom - EDGE
  if (top > blockLimit) top = Math.max(blockTop, visibleTop)
  return { top, left }
}
