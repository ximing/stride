import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { getGlobalContainer, register, resolve } from '@rabjs/react'
import { MemoryFileSystem, type FileSystemBackend } from '@stride/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { createImageExtension } from '../image/image'
import { VaultService } from '../../services/vault/vault.service'
import { createPasteExtension } from './paste-plugin'

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

function imageTransfer(files: File[]): DataTransfer {
  const items = files.map((file) => ({
    kind: 'file' as const,
    type: file.type,
    getAsFile: () => file,
  }))
  return {
    items,
    files,
    getData: () => '',
  } as unknown as DataTransfer
}

function imageSrcs(editor: Editor): string[] {
  const srcs: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image' && typeof node.attrs.src === 'string') srcs.push(node.attrs.src)
  })
  return srcs
}

function createEditor(
  getFs: () => FileSystemBackend | null,
  onPasteError?: (message: string) => void,
): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ link: false }),
      createImageExtension({ getFs }),
      createPasteExtension(getFs, onPasteError),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  editors.push(editor)
  return editor
}

function dispatchPaste(editor: Editor, files: File[]) {
  const event = new Event('paste', { cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: imageTransfer(files) })
  const handled = editor.view.someProp('handlePaste', (run) =>
    run(editor.view, event as ClipboardEvent, editor.state.selection.content()),
  )
  return { handled, event }
}

function dispatchDrop(editor: Editor, files: File[]) {
  const event = new Event('drop', { cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: imageTransfer(files) })
  Object.defineProperty(event, 'clientX', { value: 0 })
  Object.defineProperty(event, 'clientY', { value: 0 })
  const handled = editor.view.someProp('handleDrop', (run) =>
    run(editor.view, event as DragEvent, editor.state.selection.content(), false),
  )
  return { handled, event }
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  getGlobalContainer().unregister(VaultService)
})

describe('image file paste failures', () => {
  it('reports a write failure and inserts images that were already saved', async () => {
    const onPasteError = vi.fn()
    const fs = new FailWrite(2)
    const editor = createEditor(() => fs, onPasteError)
    const { handled, event } = dispatchPaste(editor, [png([1, 2, 3]), png([4, 5, 6])])
    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => {
      expect(onPasteError).toHaveBeenCalledWith('disk full')
      expect(imageSrcs(editor)).toHaveLength(1)
    })
    expect(imageSrcs(editor)[0]?.startsWith('attachments/')).toBe(true)
    expect(onPasteError).toHaveBeenCalledTimes(1)
  })

  it('reports a total write failure and inserts nothing', async () => {
    const onPasteError = vi.fn()
    const editor = createEditor(() => new FailWrite(1), onPasteError)
    dispatchPaste(editor, [png([1, 2, 3])])
    await vi.waitFor(() => {
      expect(onPasteError).toHaveBeenCalledWith('disk full')
    })
    expect(imageSrcs(editor)).toEqual([])
  })

  it('shows a write failure on vault.error when the caller does not pass a callback', async () => {
    register(VaultService)
    const vault = resolve(VaultService)
    vault.error = ''
    const editor = new Editor({
      extensions: createEditorExtensions({ getFs: () => new FailWrite(1) }),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    editors.push(editor)
    dispatchPaste(editor, [png([9, 8, 7])])
    await vi.waitFor(() => {
      expect(vault.error).toBe('disk full')
    })
    expect(imageSrcs(editor)).toEqual([])
  })

  it('does not treat a file paste as handled when there is no filesystem', () => {
    const editor = createEditor(() => null)
    const before = editor.getJSON()
    const { handled, event } = dispatchPaste(editor, [png([1, 2, 3])])
    expect(handled).toBeFalsy()
    expect(event.defaultPrevented).toBe(false)
    expect(editor.getJSON()).toEqual(before)
  })

  it('does not treat a file drop as handled when there is no filesystem', () => {
    const editor = createEditor(() => null)
    const before = editor.getJSON()
    const { handled, event } = dispatchDrop(editor, [png([1, 2, 3])])
    expect(handled).toBeFalsy()
    expect(event.defaultPrevented).toBe(false)
    expect(editor.getJSON()).toEqual(before)
  })
})
