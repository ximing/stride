// Single window capture keydown for manifest shortcuts and overlay-local keys.
// List panels, find, Radix dialogs, and the context menu used to each listen
// on window, and stopPropagation does not cancel another capture listener on
// the same node. Local keys go to the frontmost surface only.

import { has, resolve } from '@rabjs/react'
import { CommandService } from '../commands/command.service'

export type OverlayKeyLayer = 'find' | 'panel'

export interface OverlayKeyHandler {
  id: string
  layer: OverlayKeyLayer
  isOpen: () => boolean
  onKeyDown: (event: KeyboardEvent) => void
}

const handlers = new Map<string, OverlayKeyHandler>()
let listening = false

function radixDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null
}

function contextMenuOpen(): boolean {
  return document.querySelector('[data-testid="context-menu"]') !== null
}

function chooseHandler(event: KeyboardEvent): OverlayKeyHandler | null {
  // An open Radix dialog (settings, save view, editor prompt) is above the
  // list panels and the find bar. Leave Enter / Escape / arrows for it.
  if (radixDialogOpen()) return null
  const panels = [...handlers.values()].filter((handler) => handler.layer === 'panel' && handler.isOpen())
  // The context menu paints above the in-flow find bar. A list panel's
  // backdrop covers the menu, so the panel keeps the keys in that case.
  if (contextMenuOpen() && panels.length === 0) return null
  const find = [...handlers.values()].find((handler) => handler.layer === 'find' && handler.isOpen())
  const target = event.target instanceof Element ? event.target : null
  if (find && target?.closest('[data-testid="find-bar"]')) return find
  if (find && panels.length === 0) return find
  return panels[0] ?? null
}

function onWindowKeyDown(event: KeyboardEvent) {
  if (has(CommandService) && resolve(CommandService).dispatchKeydown(event)) return
  chooseHandler(event)?.onKeyDown(event)
}

function ensureListener() {
  if (listening || typeof window === 'undefined') return
  window.addEventListener('keydown', onWindowKeyDown, true)
  listening = true
}

function removeListener() {
  if (!listening || typeof window === 'undefined') return
  window.removeEventListener('keydown', onWindowKeyDown, true)
  listening = false
}

/** Register a local-key handler. The process keeps one capture listener. */
export function registerOverlayKeys(handler: OverlayKeyHandler): () => void {
  handlers.set(handler.id, handler)
  ensureListener()
  return () => {
    if (handlers.get(handler.id) === handler) handlers.delete(handler.id)
    if (handlers.size === 0) removeListener()
  }
}

/** Arrows, Enter, and Escape for the command palette, quick open, and vault search. */
export function handleOverlayListKey(
  event: KeyboardEvent,
  actions: { move: (delta: number) => void; confirm: () => void; close: () => void },
): void {
  if (event.isComposing) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    event.stopPropagation()
    actions.move(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    actions.confirm()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    actions.close()
  }
}
