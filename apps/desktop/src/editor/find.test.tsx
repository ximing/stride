import { Editor, type JSONContent } from '@tiptap/core'
import { register, resolve } from '@rabjs/react'
import { createNote, plainText } from '@stride/core/note'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { NoteEditor } from './editor'
import { createEditorExtensions } from './extensions'
import {
  findTextMatches,
  isFindShortcut,
  replaceAllMatches,
  replaceOneMatch,
  selectMatch,
} from './find'
import { VaultService } from '../services/vault.service'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
const roots: Root[] = []
const hosts: HTMLElement[] = []

function createEditor(content: JSONContent, onUpdate?: () => void): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content,
    ...(onUpdate ? { onUpdate } : {}),
  })
  editors.push(editor)
  return editor
}

function selected(editor: Editor): string {
  const { from, to } = editor.state.selection
  return editor.state.doc.textBetween(from, to)
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const chineseDoc: JSONContent = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '机器学习很有用' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '再谈机器学习' }] },
  ],
}

afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount())
  hosts.splice(0).forEach((host) => host.remove())
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe('find shortcut', () => {
  it('accepts cmd or ctrl f and ignores shift, alt, and p', () => {
    expect(isFindShortcut(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))).toBe(true)
    expect(isFindShortcut(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true }))).toBe(true)
    expect(isFindShortcut(new KeyboardEvent('keydown', { key: 'f', metaKey: true, shiftKey: true }))).toBe(false)
    expect(isFindShortcut(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isFindShortcut(new KeyboardEvent('keydown', { key: 'f', metaKey: true, altKey: true }))).toBe(false)
    expect(isFindShortcut(new KeyboardEvent('keydown', { key: 'p', metaKey: true }))).toBe(false)
    expect(isFindShortcut(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true }))).toBe(false)
    expect(isFindShortcut(new KeyboardEvent('keydown', { key: 'f' }))).toBe(false)
  })
})

describe('find text', () => {
  it('finds Chinese across text nodes but not across blocks, atoms, or regex', () => {
    const split = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '机器', marks: [{ type: 'bold' }] },
          { type: 'text', text: '学习' },
        ],
      }],
    })
    const matches = findTextMatches(split.state.doc, '机器学习')
    expect(matches).toHaveLength(1)
    selectMatch(split, matches[0]!)
    expect(selected(split)).toBe('机器学习')
    const hits = [...split.view.dom.querySelectorAll('.find-hit')].map((node) => node.textContent).join('')
    expect(hits).toBe('机器学习')

    const blocks = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '机器' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '学习' }] },
      ],
    })
    expect(findTextMatches(blocks.state.doc, '机器学习')).toEqual([])
    expect(findTextMatches(blocks.state.doc, '学习')).toHaveLength(1)

    const linked = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '机器' },
          { type: 'wikilink', attrs: { target: '机器学习' } },
          { type: 'text', text: '学习' },
        ],
      }],
    })
    expect(findTextMatches(linked.state.doc, '机器学习')).toEqual([])

    const literal = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '学习 Machine' }] }],
    })
    expect(findTextMatches(literal.state.doc, '学.')).toEqual([])
    expect(findTextMatches(literal.state.doc, 'machine')).toEqual([])
    expect(findTextMatches(literal.state.doc, 'Machine')).toHaveLength(1)
  })

  it('replaces one match, leaves the rest, and keeps the new text selected', () => {
    let updates = 0
    const editor = createEditor(chineseDoc, () => {
      updates += 1
    })
    expect(replaceOneMatch(editor, '机器学习', 0, '深度学习')).toBe(true)
    expect(updates).toBe(1)
    expect(editor.getText()).toContain('深度学习很有用')
    expect(editor.getText().match(/机器学习/g)).toHaveLength(1)
    expect(selected(editor)).toBe('深度学习')
    expect(replaceOneMatch(editor, '', 0, '深度学习')).toBe(false)
    expect(updates).toBe(1)

    const shorter = createEditor(chineseDoc)
    expect(replaceOneMatch(shorter, '机器学习', 0, '深度')).toBe(true)
    expect(shorter.getText()).toContain('深度很有用')
    expect(shorter.getText().match(/机器学习/g)).toHaveLength(1)
    expect(selected(shorter)).toBe('深度')
  })

  it('replaces every match in one undo step and ignores an empty query', () => {
    let updates = 0
    const editor = createEditor(chineseDoc, () => {
      updates += 1
    })
    const before = editor.getJSON()
    expect(replaceAllMatches(editor, '', '深度学习')).toBe(0)
    expect(replaceAllMatches(editor, '没有', '深度学习')).toBe(0)
    expect(editor.getJSON()).toEqual(before)
    expect(updates).toBe(0)

    expect(replaceAllMatches(editor, '机器学习', '深度')).toBe(2)
    expect(updates).toBe(1)
    expect(editor.getText()).toContain('深度很有用')
    expect(editor.getText()).toContain('再谈深度')
    expect(editor.getText().match(/机器学习/g)).toBeNull()
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON()).toEqual(before)
  })
})

describe('find bar', () => {
  async function mount(body: string) {
    register(VaultService)
    const vault = resolve(VaultService)
    const note = createNote('ml', '笔记')
    note.properties = { topic: '机器学习' }
    note.doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    }
    vault.notes = [note]
    vault.activeId = note.id
    vault.saveStatus = 'idle'
    vault.error = ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    hosts.push(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => {
      root.render(<NoteEditor />)
    })
    return { vault, host }
  }

  async function settle(vault: VaultService) {
    await act(async () => {
      await vault.flush()
    })
  }

  it('opens on cmd-f without taking shift-f or p', async () => {
    const { host } = await mount('机器学习与机器学习')
    expect(host.querySelector('[data-testid="find-bar"]')).toBeNull()

    const shifted = press({ key: 'f', metaKey: true, shiftKey: true })
    const ctrlShift = press({ key: 'F', ctrlKey: true, shiftKey: true })
    const quick = press({ key: 'p', metaKey: true })
    const alt = press({ key: 'f', metaKey: true, altKey: true })
    expect(shifted.defaultPrevented).toBe(false)
    expect(ctrlShift.defaultPrevented).toBe(false)
    expect(quick.defaultPrevented).toBe(false)
    expect(alt.defaultPrevented).toBe(false)
    expect(host.querySelector('[data-testid="find-bar"]')).toBeNull()

    let openEvent!: KeyboardEvent
    await act(async () => {
      openEvent = press({ key: 'f', metaKey: true })
    })
    expect(openEvent.defaultPrevented).toBe(true)
    const input = host.querySelector('[data-testid="find-input"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(host.querySelector('[data-testid="find-count"]')?.textContent).toBe('0')
    input.blur()
    await act(async () => {
      press({ key: 'f', ctrlKey: true })
    })
    expect(document.activeElement).toBe(input)

    const shiftedWhileOpen = press({ key: 'f', metaKey: true, shiftKey: true })
    const quickWhileOpen = press({ key: 'p', ctrlKey: true })
    expect(shiftedWhileOpen.defaultPrevented).toBe(false)
    expect(quickWhileOpen.defaultPrevented).toBe(false)
    expect(host.querySelector('[data-testid="find-bar"]')).not.toBeNull()

    await act(async () => {
      press({ key: 'Escape' })
    })
    expect(host.querySelector('[data-testid="find-bar"]')).toBeNull()
  })

  it('finds 机器学习, replaces one, then replaces the rest through the editor', async () => {
    const { vault, host } = await mount('机器学习与机器学习')
    await act(async () => {
      press({ key: 'f', metaKey: true })
    })
    const findInput = host.querySelector('[data-testid="find-input"]') as HTMLInputElement
    const replaceInput = host.querySelector('[data-testid="replace-input"]') as HTMLInputElement
    await act(async () => {
      setInput(findInput, '机器学习')
    })
    expect(host.querySelector('[data-testid="find-count"]')?.textContent).toBe('1/2')
    expect(host.querySelector('.find-hit')?.textContent).toBe('机器学习')
    await act(async () => {
      ;(host.querySelector('[data-testid="find-prev"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[data-testid="find-count"]')?.textContent).toBe('2/2')
    await act(async () => {
      ;(host.querySelector('[data-testid="find-next"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[data-testid="find-count"]')?.textContent).toBe('1/2')

    await act(async () => {
      setInput(replaceInput, '深度学习')
      ;(host.querySelector('[data-testid="replace-one"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('深度学习与机器学习')
    expect(plainText(vault.active?.doc ?? { type: 'doc' })).toContain('深度学习与机器学习')
    expect(plainText(vault.active?.doc ?? { type: 'doc' }).match(/机器学习/g)).toHaveLength(1)
    expect(vault.active?.properties.topic).toBe('机器学习')
    expect(vault.saveStatus).toBe('pending')

    await act(async () => {
      ;(host.querySelector('[data-testid="replace-all"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('深度学习与深度学习')
    expect(plainText(vault.active?.doc ?? { type: 'doc' }).match(/机器学习/g)).toBeNull()
    expect(plainText(vault.active?.doc ?? { type: 'doc' })).toContain('深度学习与深度学习')
    expect(vault.active?.properties.topic).toBe('机器学习')
    await settle(vault)
  })

  it('shows 0 and does not change the note for a miss or an empty query', async () => {
    const { vault, host } = await mount('机器学习')
    await act(async () => {
      press({ key: 'f', metaKey: true })
    })
    const findInput = host.querySelector('[data-testid="find-input"]') as HTMLInputElement
    const before = JSON.stringify(vault.active?.doc)
    await act(async () => {
      setInput(findInput, '没有')
      ;(host.querySelector('[data-testid="find-next"]') as HTMLButtonElement).click()
      ;(host.querySelector('[data-testid="replace-one"]') as HTMLButtonElement).click()
      ;(host.querySelector('[data-testid="replace-all"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[data-testid="find-count"]')?.textContent).toBe('0')
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('机器学习')
    expect(JSON.stringify(vault.active?.doc)).toBe(before)

    await act(async () => {
      setInput(findInput, '')
      setInput(host.querySelector('[data-testid="replace-input"]') as HTMLInputElement, '深度学习')
      ;(host.querySelector('[data-testid="replace-one"]') as HTMLButtonElement).click()
      ;(host.querySelector('[data-testid="replace-all"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[data-testid="find-count"]')?.textContent).toBe('0')
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('机器学习')
    expect(JSON.stringify(vault.active?.doc)).toBe(before)
    expect(vault.saveStatus).toBe('idle')
  })
})
