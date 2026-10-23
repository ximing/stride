import { Editor } from '@tiptap/core'
import { parseNote, serializeNote, type TipTapNode } from '@stride/core/note'
import { MemoryFileSystem } from '@stride/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { attachmentPath, localizeRemoteImage, saveAttachment, storeImageFiles } from './image'

const layoutBox = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 1,
  bottom: 1,
  width: 1,
  height: 1,
  toJSON() {
    return {}
  },
})

if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects() {
    const list = [layoutBox()]
    return Object.assign(list, { item: (index: number) => list[index] ?? null }) as unknown as DOMRectList
  }
}
if (typeof Range !== 'undefined' && typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return layoutBox() as DOMRect
  }
}

const editors: Editor[] = []

function createEditor(fs: MemoryFileSystem): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions({
      getFs: () => fs,
    }),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.querySelector('[data-testid="image-lightbox"]')?.remove()
  editors.splice(0).forEach((editor) => editor.destroy())
})

class FailWrite extends MemoryFileSystem {
  private writes = 0

  constructor(private readonly failAt: number) {
    super()
  }

  override async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.writes += 1
    if (this.writes >= this.failAt) throw new Error('disk full')
    return super.writeBytes(path, data)
  }
}

function png(bytes: number[]): File {
  return new File([new Uint8Array(bytes)], 'pic.png', { type: 'image/png' })
}

describe('image attachments', () => {
  it('writes bytes under attachments and reads them back', async () => {
    const fs = new MemoryFileSystem()
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const path = await saveAttachment(fs, new Blob([bytes], { type: 'image/png' }))
    expect(path.startsWith('attachments/')).toBe(true)
    expect(path.startsWith('blob:')).toBe(false)
    expect(path.startsWith('data:')).toBe(false)
    expect(await fs.readBytes(path)).toEqual(bytes)
  })

  it('does not reuse a path when later bytes differ', () => {
    const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const first = attachmentPath(new Uint8Array([...header, 1, 2, 3]), 'png')
    const second = attachmentPath(new Uint8Array([...header, 1, 2, 4]), 'png')
    expect(first.startsWith('attachments/')).toBe(true)
    expect(second.startsWith('attachments/')).toBe(true)
    expect(first).not.toBe(second)
  })

  it('returns attachment paths when every file is saved', async () => {
    const fs = new MemoryFileSystem()
    const paths = await storeImageFiles(fs, [png([1, 2, 3])])
    expect(paths).toHaveLength(1)
    expect(paths[0]?.startsWith('attachments/')).toBe(true)
    expect(await fs.readBytes(paths[0]!)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('resolves an empty list when the first write fails and reports it', async () => {
    const fs = new FailWrite(1)
    const onError = vi.fn()
    await expect(storeImageFiles(fs, [png([1, 2, 3])], onError)).resolves.toEqual([])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: 'disk full' })
  })

  it('resolves paths written before a later file fails and reports it', async () => {
    const fs = new FailWrite(2)
    const onError = vi.fn()
    const saved = await storeImageFiles(fs, [png([1, 2, 3]), png([4, 5, 6])], onError)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.startsWith('attachments/')).toBe(true)
    expect(await fs.readBytes(saved[0]!)).toEqual(new Uint8Array([1, 2, 3]))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: 'disk full' })
  })

  it('still resolves the saved prefix when no failure callback is passed', async () => {
    const fs = new FailWrite(2)
    const seen: string[][] = []
    const saved = await storeImageFiles(fs, [png([1, 2, 3]), png([4, 5, 6])]).then((srcs) => {
      seen.push(srcs)
      return srcs
    })
    expect(seen).toEqual([saved])
    expect(saved).toHaveLength(1)
    expect(saved[0]?.startsWith('attachments/')).toBe(true)
  })

  it('keeps a remote url when fetch fails', async () => {
    const fs = new MemoryFileSystem()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const url = 'https://example.invalid/a.png'
    await expect(localizeRemoteImage(fs, url)).resolves.toBe(url)
  })

  it('round-trips an image src through the note file', () => {
    const editor = createEditor(new MemoryFileSystem())
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'attachments/a.png' } }],
    })
    const canonical = editor.getJSON()
    const parsed = parseNote(serializeNote({
      id: 'img',
      title: 'Img',
      type: 'note',
      properties: {},
      doc: canonical as TipTapNode,
    }), 'img')
    editor.commands.setContent(parsed.doc)
    expect(editor.getJSON()).toEqual(canonical)
  })
})
