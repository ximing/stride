import { has, resolve } from '@rabjs/react'
import { plainWikilinks } from '@stride/core/note'
import type { FileSystemBackend } from '@stride/platform'
import { Extension, type Editor } from '@tiptap/core'
import { Fragment, Slice, type Node as PmNode } from '@tiptap/pm/model'
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state'
import { t } from '../../i18n'
import { VaultService } from '../../services/vault/vault.service'
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
export function createPasteExtension(
  getFs: () => FileSystemBackend | null,
  onPasteError?: (message: string) => void,
) {
  const report = (error: unknown) => {
    showPasteError(error, onPasteError)
  }
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
                const fs = getFs()
                // No filesystem: do not cancel the event. Returning true here drops the file.
                if (!fs) return false
                event.preventDefault()
                const { from, to } = editor.state.selection
                insertImagesLater(editor, from, to, storeImageFiles(fs, files, report), report)
                return true
              }
              if (dispatchClipboardText(editor, data, getFs)) {
                event.preventDefault()
                return true
              }
              const plain = data.getData('text/plain') ?? ''
              if (!plain || !insertPlainWikilinks(editor, plain)) return false
              event.preventDefault()
              return true
            },
            handleDrop(view, event, _slice, moved) {
              if (moved || editor.isDestroyed) return false
              const data = event.dataTransfer
              if (!data) return false
              const files = imageFiles(data)
              const imageFs = files.length > 0 ? getFs() : null
              if (files.length > 0 && !imageFs) return false
              const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
              const pos = coords?.pos ?? view.state.selection.from
              if (files.length > 0 && imageFs) {
                event.preventDefault()
                insertImagesLater(editor, pos, pos, storeImageFiles(imageFs, files, report), report)
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
 * the keyboard dispatch. A plain `[[target|alias]]` uses that same split.
 * Anything else is ProseMirror plain text, not HTML.
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
  if (insertPlainWikilinks(editor, text)) return
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

function selectionInCode(state: EditorState): boolean {
  const points = [state.selection.$from, state.selection.$to]
  for (const pos of points) {
    for (let depth = pos.depth; depth > 0; depth -= 1) {
      if (pos.node(depth).type.spec.code) return true
    }
    if (pos.marks().some((mark) => mark.type.spec.code)) return true
  }
  return false
}

function inlineWikilinkContent(editor: Editor, line: string): Fragment {
  const wikilink = editor.schema.nodes.wikilink
  if (!wikilink) return Fragment.empty
  const marks = editor.state.storedMarks ?? editor.state.selection.$from.marks()
  const nodes: PmNode[] = []
  let cursor = 0
  for (const link of plainWikilinks(line)) {
    const before = line.slice(cursor, link.start)
    if (before) nodes.push(editor.schema.text(before, marks))
    const attrs = link.alias ? { target: link.target, alias: link.alias } : { target: link.target }
    nodes.push(wikilink.create(attrs))
    cursor = link.end
  }
  const after = line.slice(cursor)
  if (after) nodes.push(editor.schema.text(after, marks))
  return Fragment.from(nodes)
}

function plainWikilinkSlice(editor: Editor, text: string): Slice | null {
  const paragraph = editor.schema.nodes.paragraph
  if (!paragraph) return null
  const blocks = text.split(/\r\n?|\n/).map((line) => paragraph.create(null, inlineWikilinkContent(editor, line)))
  const only = blocks[0]
  if (blocks.length === 1 && only) return new Slice(only.content, 0, 0)
  const openEdge = (node: PmNode | undefined) => (node?.type.name === 'paragraph' ? 1 : 0)
  return new Slice(Fragment.from(blocks), openEdge(blocks[0]), openEdge(blocks[blocks.length - 1]))
}

/** Same `[[target|alias]]` split as plain-text extraction. Code stays plain text. */
function insertPlainWikilinks(editor: Editor, text: string): boolean {
  if (!editor.schema.nodes.wikilink || plainWikilinks(text).length === 0) return false
  if (selectionInCode(editor.state)) return false
  const slice = plainWikilinkSlice(editor, text)
  if (!slice) return false
  try {
    const tr = editor.state.tr.replaceSelection(slice).scrollIntoView()
    tr.doc.check()
    editor.view.dispatch(tr)
  } catch {
    return false
  }
  return true
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

function showPasteError(error: unknown, onPasteError?: (message: string) => void): void {
  const message = pasteErrorMessage(error)
  if (onPasteError) {
    onPasteError(message)
    return
  }
  if (has(VaultService)) resolve(VaultService).error = message
}

function pasteErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return t('editor.pasteFailed')
}
