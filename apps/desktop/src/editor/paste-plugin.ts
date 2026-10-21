import type { FileSystemBackend } from '@stride/platform'
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import {
  imageFiles,
  insertStoredImages,
  localizeHttpImages,
  localizeRemoteImage,
  pastedImageUrl,
  storeImageFiles,
} from './image'
import { dispatchMarkdownPaste } from './paste-dispatch'

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
                void storeImageFiles(fs, files).then((srcs) => {
                  insertStoredImages(editor, srcs, from, to)
                })
                return true
              }
              if (dispatchMarkdownPaste(editor.view, data)) {
                const fs = getFs()
                if (fs) queueMicrotask(() => {
                  void localizeHttpImages(editor, fs)
                })
                return true
              }
              const url = pastedImageUrl(data.getData('text/plain') ?? '')
              if (!url) return false
              event.preventDefault()
              const { from, to } = editor.state.selection
              const fs = getFs()
              void (async () => {
                let src = url
                if (fs) {
                  try {
                    src = await localizeRemoteImage(fs, url)
                  } catch {
                    src = url
                  }
                }
                insertStoredImages(editor, [src], from, to)
              })()
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
                void storeImageFiles(fs, files).then((srcs) => {
                  insertStoredImages(editor, srcs, pos, pos)
                })
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
