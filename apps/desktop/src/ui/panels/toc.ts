import { plainText, stripLeadingH1, type TipTapNode } from '@stride/core/note'

export type TocItem = {
  level: 1 | 2 | 3
  text: string
  pos: number
}

const ATOM_TYPES = new Set(['hardBreak', 'horizontalRule', 'image', 'wikilink'])

function nodeSize(node: TipTapNode): number {
  if (node.type === 'text') return node.text?.length ?? 0
  if (ATOM_TYPES.has(node.type)) return 1
  let size = 2
  for (const child of node.content ?? []) size += nodeSize(child)
  return size
}

function collect(node: TipTapNode, pos: number, items: TocItem[], isDoc: boolean) {
  if (!isDoc && node.type === 'heading') {
    const level = node.attrs?.level
    if (level === 2 || level === 3) {
      items.push({ level, text: plainText(node), pos })
    }
  }
  if (node.type === 'text' || ATOM_TYPES.has(node.type)) return
  let childPos = isDoc ? pos : pos + 1
  for (const child of node.content ?? []) {
    collect(child, childPos, items, false)
    childPos += nodeSize(child)
  }
}

// Positions match the editor, which does not contain the title H1.
export function tocItems(title: string, doc: TipTapNode): TocItem[] {
  const items: TocItem[] = [{ level: 1, text: title, pos: 0 }]
  collect(stripLeadingH1(doc), 0, items, true)
  return items
}
