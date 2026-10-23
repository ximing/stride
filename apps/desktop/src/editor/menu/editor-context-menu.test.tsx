import { Editor, type JSONContent } from '@tiptap/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNote, type StrideNote } from '@stride/core/note'
import { useEditorContextMenu } from './editor-context-menu'
import { createEditorExtensions } from '../extensions'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const editors: Editor[] = []
const roots: Root[] = []

function createEditor(content: JSONContent): Editor {
  const editor = new Editor({ extensions: createEditorExtensions(), content })
  editors.push(editor)
  return editor
}

interface HarnessProps {
  editor: Editor
  notes: StrideNote[]
  onOpen: (target: string) => void
  onOpenInNewTab: (id: string) => void
  onPasteError?: (message: string) => void
}

function Harness({ editor, notes, onOpen, onOpenInNewTab, onPasteError }: HarnessProps) {
  const openLinkRef = useRef(() => true)
  const { onContextMenu, menuElement } = useEditorContextMenu({
    editor,
    notes,
    openLinkRef,
    onOpen,
    openInNewTab: onOpenInNewTab,
    onPasteError,
  })
  return (
    <div data-testid="harness" onContextMenu={onContextMenu}>
      {menuElement}
    </div>
  )
}

async function mount(props: HarnessProps): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    root.render(<Harness {...props} />)
  })
  return host
}

function rightClick(host: HTMLElement) {
  host
    .querySelector<HTMLElement>('[data-testid="harness"]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
}

function menuItemIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid^="context-menu-item-"]')].map((node) =>
    node.dataset.testid!.replace('context-menu-item-', ''),
  )
}

function clickMenuItem(id: string) {
  const node = document.querySelector<HTMLElement>(`[data-testid="context-menu-item-${id}"]`)
  expect(node).not.toBeNull()
  node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="context-menu"]')
}

function installClipboard(clipboard: { readText?: () => Promise<string>; writeText?: (text: string) => Promise<void> }) {
  Object.defineProperty(window.navigator, 'clipboard', { value: clipboard, configurable: true })
}

function docText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(docText).join('')
}

async function pasteFromMenu(host: HTMLElement): Promise<void> {
  await act(async () => {
    rightClick(host)
  })
  await act(async () => {
    clickMenuItem('paste')
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  delete (window.navigator as { clipboard?: unknown }).clipboard
})

const paragraphDoc: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
}

describe('editor context menu', () => {
  it('shows format actions for a selection; bold applies to it', async () => {
    const editor = createEditor(paragraphDoc)
    editor.commands.setTextSelection({ from: 1, to: 6 })
    const host = await mount({ editor, notes: [], onOpen: () => {}, onOpenInNewTab: () => {} })
    await act(async () => rightClick(host))
    expect(menuItemIds()).toEqual(['bold', 'italic', 'highlight', 'link', 'copy'])
    // Shortcut hints come from the toolbar chords, rendered via formatShortcut.
    const bold = document.querySelector<HTMLElement>('[data-testid="context-menu-item-bold"]')!
    expect(bold.querySelector('.sd-menu-shortcut')?.textContent).toContain('B')
    await act(async () => clickMenuItem('bold'))
    expect(menu()).toBeNull()
    expect(editor.isActive('bold')).toBe(true)
  })

  it('shows paste/select-all at the caret; select-all selects the doc', async () => {
    const editor = createEditor(paragraphDoc)
    editor.commands.setTextSelection(1)
    const host = await mount({ editor, notes: [], onOpen: () => {}, onOpenInNewTab: () => {} })
    await act(async () => rightClick(host))
    expect(menuItemIds()).toEqual(['paste', 'select-all'])
    // jsdom has no clipboard: paste is gated off.
    expect(
      document.querySelector<HTMLElement>('[data-testid="context-menu-item-paste"]')!.hasAttribute('data-disabled'),
    ).toBe(true)
    await act(async () => clickMenuItem('select-all'))
    expect(editor.state.selection.empty).toBe(false)
  })

  it('offers link actions on a resolved wikilink', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'wikilink', attrs: { target: 'Alpha' } }] }],
    })
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 1 })
    const onOpen = vi.fn()
    const onOpenInNewTab = vi.fn()
    const host = await mount({ editor, notes: [createNote('n1', 'Alpha')], onOpen, onOpenInNewTab })
    await act(async () => rightClick(host))
    expect(menuItemIds()).toEqual(['open-link', 'open-link-new-tab', 'copy-wikilink'])
    await act(async () => clickMenuItem('open-link'))
    expect(onOpen).toHaveBeenCalledWith('Alpha')
    await act(async () => rightClick(host))
    await act(async () => clickMenuItem('open-link-new-tab'))
    expect(onOpenInNewTab).toHaveBeenCalledWith('n1')
  })

  it('offers create-and-open on an unresolved wikilink', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'wikilink', attrs: { target: 'Ghost' } }] }],
    })
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 1 })
    const onOpen = vi.fn()
    const host = await mount({ editor, notes: [], onOpen, onOpenInNewTab: () => {} })
    await act(async () => rightClick(host))
    expect(menuItemIds()).toEqual(['create-and-open', 'copy-wikilink'])
    await act(async () => clickMenuItem('create-and-open'))
    expect(onOpen).toHaveBeenCalledWith('Ghost')
  })

  it('copies the wikilink text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'wikilink', attrs: { target: 'Alpha', alias: 'A' } }] }],
    })
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 1 })
    const host = await mount({ editor, notes: [createNote('n1', 'Alpha')], onOpen: () => {}, onOpenInNewTab: () => {} })
    await act(async () => rightClick(host))
    await act(async () => clickMenuItem('copy-wikilink'))
    expect(writeText).toHaveBeenCalledWith('[[Alpha|A]]')
  })

  it('pastes vector<int> as text instead of HTML', async () => {
    const readText = vi.fn().mockResolvedValue('vector<int>')
    installClipboard({ readText })
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    editor.commands.setTextSelection(1)
    const host = await mount({ editor, notes: [], onOpen: () => {}, onOpenInNewTab: () => {} })
    await pasteFromMenu(host)
    expect(docText(editor.getJSON())).toBe('vector<int>')
    expect(editor.getText()).toBe('vector<int>')
  })

  it('pastes markdown through the same dispatch as the keyboard path', async () => {
    const readText = vi.fn().mockResolvedValue('# Title\n\n- one')
    installClipboard({ readText })
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    editor.commands.setTextSelection(1)
    const host = await mount({ editor, notes: [], onOpen: () => {}, onOpenInNewTab: () => {} })
    await pasteFromMenu(host)
    expect(JSON.stringify(editor.getJSON())).toContain('"type":"heading"')
    expect(editor.getText()).not.toContain('# Title')
  })

  it('reports a clipboard read failure instead of swallowing it', async () => {
    const readText = vi.fn().mockRejectedValue(new Error('clipboard denied'))
    installClipboard({ readText })
    const onPasteError = vi.fn()
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    const host = await mount({ editor, notes: [], onOpen: () => {}, onOpenInNewTab: () => {}, onPasteError })
    await pasteFromMenu(host)
    expect(onPasteError).toHaveBeenCalledWith('clipboard denied')
    expect(editor.getText()).toBe('')
  })

  it('reports an insert failure instead of swallowing it', async () => {
    const readText = vi.fn().mockResolvedValue('vector<int>')
    installClipboard({ readText })
    const onPasteError = vi.fn()
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    vi.spyOn(editor.view, 'pasteText').mockImplementation(() => {
      throw new Error('insert failed')
    })
    const host = await mount({ editor, notes: [], onOpen: () => {}, onOpenInNewTab: () => {}, onPasteError })
    await pasteFromMenu(host)
    expect(onPasteError).toHaveBeenCalledWith('insert failed')
    expect(docText(editor.getJSON())).toBe('')
  })
})
