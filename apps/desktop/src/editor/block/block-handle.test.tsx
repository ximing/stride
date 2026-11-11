import { Editor, type JSONContent } from '@tiptap/core'
import { act, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { BlockHandle } from './block-handle'
import '../../i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const editors: Editor[] = []
const roots: Root[] = []

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return {}
    },
  } as DOMRect
}

function Harness({ editor }: { editor: Editor }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    hostRef.current?.append(editor.view.dom)
  }, [editor])
  return (
    <div className="editor-scroll" data-testid="block-scroll">
      <div ref={hostRef} />
      <BlockHandle editor={editor} />
    </div>
  )
}

async function mount(content: JSONContent): Promise<{ editor: Editor; host: HTMLElement }> {
  const editor = new Editor({ extensions: createEditorExtensions(), content })
  editors.push(editor)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    root.render(<Harness editor={editor} />)
  })
  const scroll = host.querySelector<HTMLElement>('[data-testid="block-scroll"]')!
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 600 })
  Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 800 })
  scroll.getBoundingClientRect = () => rect(0, 0, 800, 600)
  return { editor, host }
}

function showBlock(host: HTMLElement, selector: string, top = 40) {
  const node = host.querySelector<HTMLElement>(selector)
  expect(node).not.toBeNull()
  const shell = node!.closest<HTMLElement>('.editor-code, .tableWrapper') ?? node!
  shell.getBoundingClientRect = () => rect(80, top, 400, 120)
  act(() => {
    node!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 100, clientY: top + 10 }))
  })
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

describe('BlockHandle', () => {
  it('starts as a square, then expands to copy, cut, and delete', async () => {
    const { editor, host } = await mount({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'alpha' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    })
    expect(host.querySelector('[data-testid="block-actions"]')).toBeNull()
    showBlock(host, '.editor-code')
    const bar = host.querySelector<HTMLElement>('[data-testid="block-actions"]')
    expect(bar?.dataset.kind).toBe('codeBlock')
    expect(bar?.dataset.open).toBe('false')
    expect(bar?.querySelector('[data-testid="block-action-toggle"]')).not.toBeNull()
    expect(bar?.querySelector('[data-testid="block-action-copy"]')).toBeNull()

    await act(async () => {
      bar!.querySelector<HTMLButtonElement>('[data-testid="block-action-toggle"]')!.click()
    })
    expect(bar?.dataset.open).toBe('true')
    expect(bar?.querySelector('[data-testid="block-action-copy"]')).not.toBeNull()
    expect(bar?.querySelector('[data-testid="block-action-cut"]')).not.toBeNull()
    expect(bar?.querySelector('[data-testid="block-action-delete"]')).not.toBeNull()

    await act(async () => {
      bar!.querySelector<HTMLButtonElement>('[data-testid="block-action-toggle"]')!.click()
    })
    expect(bar?.querySelector('[data-testid="block-action-delete"]')).toBeNull()

    await act(async () => {
      bar!.querySelector<HTMLButtonElement>('[data-testid="block-action-toggle"]')!.click()
    })
    await act(async () => {
      bar!.querySelector<HTMLButtonElement>('[data-testid="block-action-delete"]')!.click()
    })
    expect(editor.getJSON().content?.some((node) => node.type === 'codeBlock')).toBe(false)
    expect(editor.getText()).toContain('after')
  })

  it('shows the bar for a table and hides it when the pointer moves to a paragraph', async () => {
    const { host } = await mount({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'note' }] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
              ],
            },
          ],
        },
      ],
    })
    showBlock(host, 'td', 80)
    expect(host.querySelector('[data-testid="block-actions"]')?.getAttribute('data-kind')).toBe('table')

    const paragraph = host.querySelector('p')!
    await act(async () => {
      paragraph.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 90, clientY: 20 }))
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(host.querySelector('[data-testid="block-actions"]')).toBeNull()
  })
})
