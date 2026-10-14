import { Node, mergeAttributes, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { FileSystemBackend } from '@stride/platform'

const mimeExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const imagePluginKey = new PluginKey('imageAttachment')

export function imageMimeExtension(type: string): string {
  const mime = type.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return mimeExtensions[mime] ?? 'bin'
}

export function attachmentPath(bytes: Uint8Array, ext: string): string {
  let hash = 2166136261
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!
    hash = Math.imul(hash, 16777619)
  }
  hash = Math.imul(hash ^ bytes.length, 16777619) >>> 0
  return `attachments/${hash.toString(16).padStart(8, '0')}.${ext}`
}

async function blobBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer())
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('Blob read failed'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'))
    reader.readAsArrayBuffer(file)
  })
  return new Uint8Array(buffer)
}

export async function saveAttachment(fs: FileSystemBackend, file: Blob): Promise<string> {
  const bytes = await blobBytes(file)
  const path = attachmentPath(bytes, imageMimeExtension(file.type))
  const existing = await fs.stat('attachments')
  if (!existing) await fs.mkdir('attachments')
  await fs.writeBytes(path, bytes)
  return path
}

export async function localizeRemoteImage(fs: FileSystemBackend, url: string): Promise<string> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return url
  try {
    const response = await fetch(url)
    if (!response.ok) return url
    return await saveAttachment(fs, await response.blob())
  } catch {
    return url
  }
}

export const imageSlashCommand = {
  id: 'image',
  title: '图片',
  keywords: 'image img 图片',
  run(editor: Editor) {
    editor.commands.insertContent({ type: 'image', attrs: { src: '' } })
  },
}

function pastedImageUrl(text: string): string | null {
  const value = text.trim()
  if (!value.startsWith('http://') && !value.startsWith('https://')) return null
  if (/\s/.test(value)) return null
  try {
    if (!/\.(png|jpg|jpeg|gif|webp)$/i.test(new URL(value).pathname)) return null
  } catch {
    return null
  }
  return value
}

function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  const items = data.items
  if (items && items.length > 0) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files)) {
      if (file.type.startsWith('image/')) files.push(file)
    }
  }
  return files
}

function insertImages(editor: Editor, srcs: string[], pos: number) {
  if (editor.isDestroyed || srcs.length === 0) return
  const content = srcs.map((src) => ({ type: 'image', attrs: { src } }))
  const inserted = editor.chain().insertContentAt(pos, content).run()
  if (!inserted) editor.chain().insertContent(content).run()
}

function mimeFromPath(src: string): string {
  const ext = src.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'application/octet-stream'
}

function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy.buffer], { type })
}

function revokeUrl(url: string | null) {
  if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

function openLightbox(src: string) {
  if (!src) return
  document.querySelector('[data-testid="image-lightbox"]')?.remove()
  const backdrop = document.createElement('div')
  backdrop.className = 'image-lightbox'
  backdrop.dataset.testid = 'image-lightbox'
  const picture = document.createElement('img')
  picture.src = src
  picture.alt = ''
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) backdrop.remove()
  })
  backdrop.append(picture)
  document.body.append(backdrop)
}

export function createImageExtension(options: {
  getFs: () => FileSystemBackend | null
  onUploaded?: (path: string) => void
}) {
  const remember = (path: string) => {
    if (path.startsWith('attachments/')) options.onUploaded?.(path)
  }

  const storeFiles = async (files: File[], pos: number, editor: Editor) => {
    const fs = options.getFs()
    if (!fs) return
    const srcs: string[] = []
    try {
      for (const file of files) {
        const path = await saveAttachment(fs, file)
        remember(path)
        srcs.push(path)
      }
    } catch {
      // Keep whatever already saved. Do not insert blob: or data: urls.
    }
    insertImages(editor, srcs, pos)
  }

  return Node.create({
    name: 'image',
    inline: false,
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes() {
      return {
        src: { default: '' },
      }
    },
    parseHTML() {
      return [{ tag: 'img[src]' }]
    },
    renderHTML({ HTMLAttributes }) {
      return ['img', mergeAttributes(HTMLAttributes)]
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('div')
        dom.className = 'editor-image'
        dom.contentEditable = 'false'

        const img = document.createElement('img')
        img.alt = ''
        img.draggable = false

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'editor-image-pick'
        button.dataset.testid = 'image-pick'
        button.textContent = '选择图片'

        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.hidden = true

        const onRead = async (src: string): Promise<Uint8Array | null> => {
          const fs = options.getFs()
          if (!fs || !src) return null
          try {
            return await fs.readBytes(src)
          } catch {
            return null
          }
        }

        const onPick = async (file: File) => {
          const fs = options.getFs()
          if (!fs) return
          try {
            const path = await saveAttachment(fs, file)
            remember(path)
            const pos = typeof getPos === 'function' ? getPos() : undefined
            if (typeof pos !== 'number' || editor.isDestroyed) return
            const current = editor.state.doc.nodeAt(pos)
            if (!current || current.type.name !== 'image') return
            editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, {
              ...current.attrs,
              src: path,
            }))
          } catch {
            // Leave the current src in place.
          }
        }

        button.addEventListener('click', () => {
          input.click()
        })
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          input.value = ''
          if (file) void onPick(file)
        })
        img.addEventListener('dblclick', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const shown = img.getAttribute('src')
          if (shown) openLightbox(shown)
        })

        let objectUrl: string | null = null
        let shown = ''
        let generation = 0

        const paint = (src: string) => {
          shown = src
          const generationId = ++generation
          revokeUrl(objectUrl)
          objectUrl = null
          if (!src) {
            img.removeAttribute('src')
            img.hidden = true
            button.hidden = false
            return
          }
          button.hidden = true
          img.hidden = false
          void (async () => {
            const bytes = await onRead(src)
            if (generationId !== generation) return
            if (!bytes || typeof URL.createObjectURL !== 'function') {
              if (src.startsWith('http://') || src.startsWith('https://')) img.src = src
              return
            }
            objectUrl = URL.createObjectURL(bytesToBlob(bytes, mimeFromPath(src)))
            if (generationId !== generation) {
              revokeUrl(objectUrl)
              objectUrl = null
              return
            }
            img.src = objectUrl
          })()
        }

        dom.append(img, button, input)
        paint(typeof node.attrs.src === 'string' ? node.attrs.src : '')

        return {
          dom,
          update: (updated) => {
            if (updated.type.name !== 'image') return false
            const next = typeof updated.attrs.src === 'string' ? updated.attrs.src : ''
            if (next !== shown) paint(next)
            return true
          },
          destroy: () => {
            generation += 1
            revokeUrl(objectUrl)
            objectUrl = null
          },
          ignoreMutation: () => true,
          stopEvent: (event) => {
            const target = event.target
            return target === button || target === input
          },
        }
      }
    },
    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        new Plugin({
          key: imagePluginKey,
          props: {
            handlePaste: (view, event) => {
              const files = imageFiles(event.clipboardData)
              if (files.length > 0) {
                event.preventDefault()
                if (!options.getFs()) return true
                void storeFiles(files, view.state.selection.from, editor)
                return true
              }
              const url = pastedImageUrl(event.clipboardData?.getData('text/plain') ?? '')
              if (!url) return false
              event.preventDefault()
              const fs = options.getFs()
              if (!fs) return true
              const pos = view.state.selection.from
              void (async () => {
                let src = url
                try {
                  src = await localizeRemoteImage(fs, url)
                } catch {
                  src = url
                }
                remember(src)
                insertImages(editor, [src], pos)
              })()
              return true
            },
            handleDrop: (view, event, _slice, moved) => {
              if (moved) return false
              const files = imageFiles(event.dataTransfer)
              if (files.length === 0) return false
              event.preventDefault()
              if (!options.getFs()) return true
              const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
              void storeFiles(files, coords?.pos ?? view.state.selection.from, editor)
              return true
            },
          },
        }),
      ]
    },
  })
}
