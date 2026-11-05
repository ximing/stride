// Context-menu clipboard access. A keyboard copy/paste carries text/html, so
// tables, marks and custom nodes survive between notes; the menu actions must
// do the same instead of dropping to plain text.
//
// Both helpers degrade to the text-only API: copy falls back to writeText when
// ClipboardItem is missing, paste falls back to readText when read() is denied
// or unavailable (jsdom, older WebKit).

import type { Editor } from '@tiptap/core'

export interface ClipboardPasteData {
  html: string
  text: string
}

type ClipboardWriter = {
  write?: (items: ClipboardItem[]) => Promise<void>
  writeText?: (text: string) => Promise<void>
}

type ClipboardReaderFull = ClipboardWriter & {
  read?: () => Promise<ClipboardItem[]>
  readText?: () => Promise<string>
}

function clipboard(): ClipboardReaderFull | undefined {
  return typeof navigator !== 'undefined' ? (navigator.clipboard as ClipboardReaderFull | undefined) : undefined
}

/** Serialize the selection like a keyboard copy: rich HTML plus plain text. */
export async function copySelectionToClipboard(editor: Editor): Promise<boolean> {
  if (editor.isDestroyed) return false
  const board = clipboard()
  if (!board) return false
  const { dom, text } = editor.view.serializeForClipboard(editor.state.selection.content())
  const html = dom.innerHTML
  if (typeof board.write === 'function' && typeof ClipboardItem === 'function') {
    try {
      await board.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ])
      return true
    } catch {
      // A denied rich write still allows the plain-text fallback.
    }
  }
  if (typeof board.writeText !== 'function') return false
  await board.writeText(text)
  return true
}

/** Read text/html and text/plain; null when no clipboard API is available. */
export async function readClipboardData(): Promise<ClipboardPasteData | null> {
  const board = clipboard()
  if (!board) return null
  if (typeof board.read === 'function') {
    try {
      const items = await board.read()
      for (const item of items) {
        const html = await readType(item, 'text/html')
        const text = await readType(item, 'text/plain')
        if (html || text) return { html, text }
      }
      return { html: '', text: '' }
    } catch {
      // Permission denied or unsupported payload: retry with plain text.
    }
  }
  if (typeof board.readText !== 'function') return null
  const text = await board.readText()
  return { html: '', text }
}

async function readType(item: ClipboardItem, type: string): Promise<string> {
  if (!item.types.includes(type)) return ''
  try {
    return await (await item.getType(type)).text()
  } catch {
    return ''
  }
}
