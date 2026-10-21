// Editor context menu (T6.9). A hook so NoteEditor stays lean and tests can
// mount it against any editor instance. All item logic lives in the pure
// buildEditorMenu (services/commands/context-menu.ts); here we only gather TipTap
// state and wire actions.
//
// TipTap interplay:
// - The handler preventDefaults on the wrapper, so the native menu never
//   replaces it. ProseMirror keeps its selection in document state (not DOM
//   focus), so focusing the popup does not disturb the selection the format
//   commands will act on.
// - Wikilink hit-testing reuses the click plugin's rule (wikilinkAt): a
//   right-click on a wikilink shows link actions instead of format actions.
// - Format/link/copy/paste/select-all are TipTap-domain commands and stay out
//   of the app manifest by design; shortcut hints come from the toolbar's
//   editorTools chords via formatShortcut — never hard-coded.

import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import type { StrideNote } from '@stride/core/note'
import type { FileSystemBackend } from '@stride/platform'
import { formatShortcut } from '../../services/commands/commands'
import { buildEditorMenu, type ContextMenuEntry } from '../../services/commands/context-menu'
import { ContextMenu } from '../../ui/overlays/context-menu'
import { runFormat } from '../extensions'
import { insertStoredImages, localizeHttpImages, localizeRemoteImage, pastedImageUrl } from '../image/image'
import { dispatchMarkdownPaste } from '../paste/paste-dispatch'
import { editorTools } from '../toolbar/toolbar'
import { resolveWikilinkClick, wikilinkAt } from '../wikilink/wikilink'

function toolChord(id: string): string | null {
  const keys = editorTools.find((tool) => tool.id === id)?.keys
  return keys ? formatShortcut(keys) : null
}

function clipboardCan(action: 'readText' | 'writeText'): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.[action] === 'function'
}

export interface EditorContextMenuDeps {
  editor: Editor | null
  /** Vault notes, for wikilink resolution (linkable filtering included). */
  notes: readonly StrideNote[]
  /** Opens the toolbar's link form for the current selection. */
  openLinkRef: { current: () => boolean }
  /** Saves pasted images into the vault. Omitted in tests that have no files. */
  getFs?: () => FileSystemBackend | null
  /** Same behavior as a wikilink click: open, or create-then-open. */
  onOpen: (target: string) => void
  /** Open a resolved note in its own tab (TabsService.openNote). */
  openInNewTab: (noteId: string) => void
}

export function useEditorContextMenu(deps: EditorContextMenuDeps): {
  onContextMenu: (event: ReactMouseEvent) => void
  menuElement: ReactNode
} {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null)

  function onContextMenu(event: ReactMouseEvent) {
    const editor = deps.editor
    if (!editor || editor.isDestroyed) return
    event.preventDefault()
    const target = event.target
    if (target instanceof Element && target.closest('td, th')) return
    // posAtCoords needs DOM geometry; a detached view (or jsdom) throws
    // instead of returning null, and a failed hit test must not kill the menu.
    let hit: { target: string; alias: string } | null = null
    try {
      const coords = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
      hit = coords ? wikilinkAt(editor, coords.pos) : null
    } catch {
      hit = null
    }
    const wikilink = hit
      ? { ...hit, resolved: resolveWikilinkClick(deps.notes, hit.target).type === 'select' }
      : null
    const { from, to, empty } = editor.state.selection
    const items = buildEditorMenu(
      {
        hasSelection: !empty,
        editable: editor.isEditable,
        clipboardRead: clipboardCan('readText'),
        clipboardWrite: clipboardCan('writeText'),
        wikilink,
        shortcuts: { bold: toolChord('bold'), italic: toolChord('italic'), highlight: toolChord('highlight') },
      },
      {
        format: (name) => runFormat(editor, name),
        link: () => deps.openLinkRef.current(),
        copy: () => {
          void navigator.clipboard?.writeText(editor.state.doc.textBetween(from, to, ' '))
        },
        paste: () => {
          void navigator.clipboard
            ?.readText()
            .then(async (text) => {
              if (!text || editor.isDestroyed) return
              const clipboard = {
                getData: (type: string) =>
                  type === 'text/plain' || type === 'text/markdown' || type === 'text/x-markdown' ? text : '',
              }
              if (dispatchMarkdownPaste(editor.view, clipboard)) {
                const fs = deps.getFs?.()
                if (fs) queueMicrotask(() => {
                  void localizeHttpImages(editor, fs)
                })
                return
              }
              const url = pastedImageUrl(text)
              const fs = deps.getFs?.() ?? null
              if (url && fs) {
                const { from, to } = editor.state.selection
                let src = url
                try {
                  src = await localizeRemoteImage(fs, url)
                } catch {
                  src = url
                }
                if (!editor.isDestroyed) insertStoredImages(editor, [src], from, to)
                return
              }
              if (!editor.isDestroyed) editor.commands.insertContent(text)
            })
            .catch(() => {})
        },
        selectAll: () => {
          editor.commands.selectAll()
        },
        openLink: (target) => deps.onOpen(target),
        openLinkInNewTab: (target) => {
          const action = resolveWikilinkClick(deps.notes, target)
          if (action.type === 'select') deps.openInNewTab(action.id)
        },
        copyWikilink: (text) => {
          void navigator.clipboard?.writeText(text)
        },
      },
    )
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  const menuElement = menu ? (
    <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
  ) : null

  return { onContextMenu, menuElement }
}
