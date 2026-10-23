import type { FileSystemBackend } from '@stride/platform'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, type Transaction } from '@tiptap/pm/state'
import { t } from '../../i18n'
import {
  imageFiles,
  insertStoredImages,
  localizeHttpImages,
  localizeRemoteImage,
  pastedImageUrl,
  storeImageFiles,
} from '../image/image'
import { dispatchMarkdownPaste } from './paste-dispatch'

type ClipboardReader = {
  getData: (type: string) => string
}

/**
 * Paste and drop live here, after the image node, so a file is not inserted twice.
 * Files first, then Markdown, then a lone image URL. Real rich HTML falls through.
 */
export function createPasteExtension(getFs: () => FileSystemBackend | null) {
  return Extension.create({
    name: 'stridePaste',
    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        new Plugin({
          props: {
            handlePaste(_view, event) {
              const data = event.clipboardData
              if (!data || editor.isDestroyed) return false
              const files = imageFiles(data)
              if (files.length > 0) {
                event.preventDefault()
                const fs = getFs()
                if (!fs) return true
                const { from, to } = editor.state.selection
                insertImagesLater(editor, from, to, storeImageFiles(fs, files))
                return true
              }
              if (!dispatchClipboardText(editor, data, getFs)) return false
              event.preventDefault()
              return true
            },
            handleDrop(view, event, _slice, moved) {
              if (moved || editor.isDestroyed) return false
              const data = event.dataTransfer
              if (!data) return false
              const files = imageFiles(data)
              const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
              const pos = coords?.pos ?? view.state.selection.from
              if (files.length > 0) {
                event.preventDefault()
                const fs = getFs()
                if (!fs) return true
                insertImagesLater(editor, pos, pos, storeImageFiles(fs, files))
                return true
              }
              if (!dispatchMarkdownPaste(view, data, pos)) return false
              event.preventDefault()
              const fs = getFs()
              if (fs) queueMicrotask(() => {
                void localizeHttpImages(editor, fs)
              })
              return true
            },
          },
        }),
      ]
    },
  })
}

/**
 * Context-menu paste only has plain text. Markdown and a lone image URL use
 * the keyboard dispatch. Anything else is ProseMirror plain text, not HTML.
 */
export function pasteClipboardText(
  editor: Editor,
  text: string,
  getFs: () => FileSystemBackend | null,
  onError?: (error: unknown) => void,
): void {
  if (!text || editor.isDestroyed || !editor.isEditable) return
  const data: ClipboardReader = {
    getData: (type) =>
      type === 'text/plain' || type === 'text/markdown' || type === 'text/x-markdown' ? text : '',
  }
  if (dispatchClipboardText(editor, data, getFs, onError)) return
  try {
    // pasteText builds a ClipboardEvent when none is passed. jsdom has no
    // ClipboardEvent, and a real one would make handlePaste read the clipboard
    // again. Markdown was already tried above, so this insert is plain text.
    const event = { clipboardData: null } as ClipboardEvent
    if (!editor.view.pasteText(text, event)) onError?.(new Error(t('editor.pasteFailed')))
  } catch (error) {
    onError?.(error)
  }
}

function dispatchClipboardText(
  editor: Editor,
  data: ClipboardReader,
  getFs: () => FileSystemBackend | null,
  onError?: (error: unknown) => void,
): boolean {
  if (editor.isDestroyed) return false
  if (dispatchMarkdownPaste(editor.view, data)) {
    const fs = getFs()
    if (fs) queueMicrotask(() => {
      void localizeHttpImages(editor, fs)
    })
    return true
  }
  const url = pastedImageUrl(data.getData('text/plain') ?? '')
  if (!url) return false
  const { from, to } = editor.state.selection
  const fs = getFs()
  const ready = (async () => {
    let src = url
    if (fs) {
      try {
        src = await localizeRemoteImage(fs, url)
      } catch {
        src = url
      }
    }
    return [src]
  })()
  insertImagesLater(editor, from, to, ready, onError)
  return true
}

// The file write is async. Follow the caret when the doc changes so the
// image does not replace text typed during that write. Keep a selection
// only while the doc is still the one captured at paste time.
function insertImagesLater(
  editor: Editor,
  from: number,
  to: number,
  ready: Promise<string[]>,
  onError?: (error: unknown) => void,
): void {
  const base = editor.state.doc
  let anchor = to
  const onTr = ({ transaction }: { transaction: Transaction }) => {
    anchor = transaction.mapping.map(anchor, 1)
  }
  editor.on('transaction', onTr)
  const stop = () => {
    editor.off('transaction', onTr)
  }
  void ready.then((srcs) => {
    stop()
    if (editor.isDestroyed) return
    const unchanged = editor.state.doc.eq(base)
    const pos = clampPos(editor, anchor)
    const range = unchanged ? { from, to } : { from: pos, to: pos }
    try {
      insertStoredImages(editor, srcs, range.from, range.to)
    } catch (error) {
      onError?.(error)
    }
  }).catch((error: unknown) => {
    stop()
    onError?.(error)
  })
}

function clampPos(editor: Editor, pos: number): number {
  return Math.max(0, Math.min(pos, editor.state.doc.content.size))
}
