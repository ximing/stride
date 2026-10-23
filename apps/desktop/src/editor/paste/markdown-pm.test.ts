import { describe, expect, it } from 'vitest'
import { parseMarkdownToPmJSON, type PmNode } from './markdown-pm'

function textOf(node: PmNode | undefined): string {
  if (!node) return ''
  return (node.text ?? '') + (node.content ?? []).map((child) => textOf(child)).join('')
}

describe('parseMarkdownToPmJSON unrecognized nodes', () => {
  it('keeps a heading and the raw html block from the same paste', () => {
    const doc = parseMarkdownToPmJSON('# Title\n\n<div>kept</div>\n')
    expect(doc.content?.[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Title' }],
    })
    expect(doc.content?.some((node) => node.type === 'paragraph' && textOf(node) === '<div>kept</div>')).toBe(true)
    expect(doc.content?.every((node) => node.type !== 'doc')).toBe(true)
  })

  it('keeps a heading and the raw footnote definition', () => {
    const source = '# Title\n\n[^note]: first line\n  continued\n'
    const doc = parseMarkdownToPmJSON(source)
    expect(doc.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(textOf(doc.content?.[0])).toBe('Title')
    expect(textOf(doc)).toContain('[^note]: first line\n  continued')
  })

  it('keeps unrecognized inline nodes beside recognized marks', () => {
    const doc = parseMarkdownToPmJSON(
      '**bold** <span>x</span> [^1] [label][ref]\n\n[^1]: footnote body\n\n[ref]: https://example.com\n',
    )
    const paragraph = doc.content?.[0]
    expect(paragraph?.type).toBe('paragraph')
    expect(paragraph?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }),
      ]),
    )
    expect(textOf(paragraph)).toContain('<span>x</span>')
    expect(textOf(paragraph)).toContain('[^1]')
    expect(textOf(paragraph)).toContain('[label][ref]')
    expect(textOf(doc)).toContain('[^1]: footnote body')
    expect(textOf(doc)).toContain('[ref]: https://example.com')
    expect(doc.content?.[0]?.type).not.toBe('heading')
    expect(doc.content?.some((node) => node.type === 'heading')).toBe(false)
  })

  it('keeps a link definition beside a heading without flattening the heading', () => {
    const doc = parseMarkdownToPmJSON('# Title\n\n[ref]: https://example.com "title"\n')
    expect(doc.content?.map((node) => node.type)).toEqual(['heading', 'paragraph'])
    expect(textOf(doc.content?.[0])).toBe('Title')
    expect(textOf(doc.content?.[1])).toBe('[ref]: https://example.com "title"')
  })

  it('keeps recognized list and code siblings around an html block', () => {
    const doc = parseMarkdownToPmJSON('# Title\n\n- item\n\n<div>kept</div>\n\n```ts\nconst n = 1\n```\n')
    expect(doc.content?.map((node) => node.type)).toEqual(['heading', 'bulletList', 'paragraph', 'codeBlock'])
    expect(textOf(doc)).toContain('<div>kept</div>')
    expect(doc.content?.[3]).toMatchObject({
      type: 'codeBlock',
      attrs: { language: 'ts' },
    })
    expect(textOf(doc.content?.[3])).toBe('const n = 1')
  })

  it('still structures math and mermaid when an unrecognized block is in the same paste', () => {
    const doc = parseMarkdownToPmJSON('# Title\n\n\\[\na\n\\]\n\n<div>kept</div>\n\n```mermaid\ngraph TD\n```\n')
    expect(doc.content?.map((node) => node.type)).toEqual(['heading', 'blockMath', 'paragraph', 'mermaid'])
    expect(doc.content?.[1]).toMatchObject({ type: 'blockMath', attrs: { latex: 'a' } })
    expect(textOf(doc.content?.[2])).toBe('<div>kept</div>')
    expect(doc.content?.[3]?.type).toBe('mermaid')
  })
})
