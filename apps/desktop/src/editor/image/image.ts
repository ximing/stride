import { Node, mergeAttributes, type Editor } from '@tiptap/core'
import type { FileSystemBackend } from '@stride/platform'
import { t, watchLocale } from '../../i18n'
import { MIN_IMAGE_WIDTH_PX, imageLengthPx, nextImageSize, type ImageResizeCorner } from './image-resize'

const mimeExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

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
  title: 'Image',
  keywords: 'image img 图片',
  run(editor: Editor) {
    editor.commands.insertContent({ type: 'image', attrs: { src: '' } })
  },
}

export function pastedImageUrl(text: string): string | null {
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

export function imageFiles(data: DataTransfer | null): File[] {
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

export async function storeImageFiles(
  fs: FileSystemBackend,
  files: File[],
  onError?: (error: unknown) => void,
): Promise<string[]> {
  const srcs: string[] = []
  try {
    for (const file of files) srcs.push(await saveAttachment(fs, file))
  } catch (error) {
    // Resolve the saved prefix. The toolbar only chains .then, so a rejection
    // would be unhandled and would drop files that already landed.
    onError?.(error)
  }
  return srcs
}

/** Insert stored images, replacing [from, to). A drop uses the same position twice. */
export function insertStoredImages(editor: Editor, srcs: string[], from: number, to = from): void {
  if (editor.isDestroyed || srcs.length === 0) return
  const content = srcs.map((src) => ({ type: 'image', attrs: { src } }))
  const inserted = editor.chain().insertContentAt({ from, to }, content).run()
  if (!inserted) editor.chain().insertContent(content).run()
}

export async function localizeHttpImages(editor: Editor, fs: FileSystemBackend): Promise<void> {
  if (editor.isDestroyed) return
  const jobs: { pos: number; src: string }[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'image') return
    const src = node.attrs.src
    if (typeof src === 'string' && (src.startsWith('http://') || src.startsWith('https://'))) {
      jobs.push({ pos, src })
    }
  })
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index]
    if (!job || editor.isDestroyed) return
    let next = job.src
    try {
      next = await localizeRemoteImage(fs, job.src)
    } catch {
      next = job.src
    }
    if (next === job.src || editor.isDestroyed) continue
    const current = editor.state.doc.nodeAt(job.pos)
    if (!current || current.type.name !== 'image' || current.attrs.src !== job.src) continue
    editor.view.dispatch(editor.state.tr.setNodeMarkup(job.pos, undefined, { ...current.attrs, src: next }))
  }
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
        alt: {
          default: '',
          parseHTML: (element) => element.getAttribute('alt') ?? '',
          renderHTML: (attributes) => (attributes.alt ? { alt: attributes.alt } : {}),
        },
        width: {
          default: null,
          parseHTML: (element) => imageLengthPx(element.getAttribute('width')),
          renderHTML: (attributes) => {
            const width = imageLengthPx(attributes.width)
            return width ? { width: String(width) } : {}
          },
        },
        height: {
          default: null,
          parseHTML: (element) => imageLengthPx(element.getAttribute('height')),
          renderHTML: (attributes) => {
            const height = imageLengthPx(attributes.height)
            return height ? { height: String(height) } : {}
          },
        },
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
        let current = node
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
        const applyPick = () => {
          button.textContent = t('editor.pickImage')
        }
        applyPick()
        const unwatchPick = watchLocale(applyPick)

        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.hidden = true

        const corners: ImageResizeCorner[] = ['nw', 'ne', 'sw', 'se']
        const handles = corners.map((corner) => {
          const handle = document.createElement('span')
          handle.className = `editor-image-handle is-${corner}`
          handle.dataset.corner = corner
          handle.dataset.testid = `image-resize-${corner}`
          handle.contentEditable = 'false'
          handle.addEventListener('pointerdown', (event) => {
            if (!editor.isEditable || event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            const startX = event.clientX
            const startY = event.clientY
            const rect = img.getBoundingClientRect()
            const startWidth = imageLengthPx(current.attrs.width)
              ?? Math.max(1, Math.round(rect.width || img.naturalWidth || MIN_IMAGE_WIDTH_PX))
            const startHeight = imageLengthPx(current.attrs.height)
              ?? Math.max(1, Math.round(rect.height || img.naturalHeight || startWidth))
            const maxWidth = Math.max(startWidth, editor.view.dom.clientWidth || startWidth)
            let pending: { width: number; height: number } | null = null
            const move = (ev: PointerEvent) => {
              pending = nextImageSize({
                startWidth,
                startHeight,
                deltaX: ev.clientX - startX,
                deltaY: ev.clientY - startY,
                corner,
                minWidth: MIN_IMAGE_WIDTH_PX,
                maxWidth,
              })
              applyBox(pending.width, pending.height)
            }
            const up = () => {
              handle.removeEventListener('pointermove', move)
              handle.removeEventListener('pointerup', up)
              if (!pending) return
              const pos = typeof getPos === 'function' ? getPos() : undefined
              if (typeof pos !== 'number' || editor.isDestroyed) return
              const live = editor.state.doc.nodeAt(pos)
              if (!live || live.type.name !== 'image') return
              editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, {
                ...live.attrs,
                width: pending.width,
                height: pending.height,
              }))
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', up)
            try {
              handle.setPointerCapture(event.pointerId)
            } catch {
              // jsdom has no pointer capture
            }
          })
          return handle
        })

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

        const applyBox = (width: number | null, height: number | null) => {
          if (width && width > 0) {
            img.style.width = `${width}px`
            dom.style.width = `${width}px`
          } else {
            img.style.width = ''
            dom.style.width = ''
          }
          img.style.height = height && height > 0 ? `${height}px` : ''
        }

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

        dom.append(img, button, input, ...handles)
        const altOf = (value: unknown) => (typeof value === 'string' ? value : '')
        img.alt = altOf(node.attrs.alt)
        applyBox(imageLengthPx(node.attrs.width), imageLengthPx(node.attrs.height))
        paint(typeof node.attrs.src === 'string' ? node.attrs.src : '')

        return {
          dom,
          update: (updated) => {
            if (updated.type.name !== 'image') return false
            current = updated
            img.alt = altOf(updated.attrs.alt)
            applyBox(imageLengthPx(updated.attrs.width), imageLengthPx(updated.attrs.height))
            const next = typeof updated.attrs.src === 'string' ? updated.attrs.src : ''
            if (next !== shown) paint(next)
            return true
          },
          selectNode: () => {
            dom.classList.add('is-selected')
          },
          deselectNode: () => {
            dom.classList.remove('is-selected')
          },
          destroy: () => {
            unwatchPick()
            generation += 1
            revokeUrl(objectUrl)
            objectUrl = null
          },
          ignoreMutation: () => true,
          stopEvent: (event) => {
            const target = event.target
            if (target === button || target === input) return true
            return target instanceof globalThis.Node && handles.some((handle) => handle.contains(target))
          },
        }
      }
    },
  })
}
