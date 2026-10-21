import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { isLikelyMath } from './math-html';

export type FoldRange = {
  from: number;
  to: number;
  node: ProseMirrorNode;
};

function fenceMarker(node: ProseMirrorNode): '$$' | '\\[' | '\\]' | null {
  const text = plainParagraph(node);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '$$' || trimmed === '\\[' || trimmed === '\\]') return trimmed;
  return null;
}

function plainParagraph(node: ProseMirrorNode): string | null {
  if (node.type.name !== 'paragraph') return null;
  let text = '';
  let onlyText = true;
  node.forEach((child) => {
    if (child.isText) text += child.text ?? '';
    else if (child.type.name === 'hardBreak') text += '\n';
    else onlyText = false;
  });
  return onlyText ? text : null;
}

/**
 * Join pasted fence paragraphs (`$$` … `$$` or `\[` … `\]`) into one block math node.
 * Inline `$…$` stays for paste rules; this only sees delimiters that were split by newlines.
 */
export function collectDisplayFences(doc: ProseMirrorNode): FoldRange[] {
  const blockType = doc.type.schema.nodes.blockMath;
  if (!blockType) return [];
  const ranges: FoldRange[] = [];
  const walk = (parent: ProseMirrorNode, contentStart: number): void => {
    if (parent.isTextblock) return;
    const children: { node: ProseMirrorNode; pos: number }[] = [];
    let offset = 0;
    parent.forEach((node) => {
      children.push({ node, pos: contentStart + offset });
      offset += node.nodeSize;
    });
    let i = 0;
    while (i < children.length) {
      const current = children[i];
      if (!current) break;
      const open = fenceMarker(current.node);
      if (open === '$$' || open === '\\[') {
        const close = open === '\\[' ? '\\]' : '$$';
        const parts: string[] = [];
        let j = i + 1;
        let found = false;
        for (; j < children.length; j += 1) {
          const next = children[j];
          if (!next) break;
          const marker = fenceMarker(next.node);
          if (marker === close) {
            found = true;
            break;
          }
          if (marker) break;
          const text = plainParagraph(next.node);
          if (text === null) break;
          parts.push(text);
        }
        const closer = children[j];
        if (found && closer) {
          const latex = parts.join('\n').trim();
          if (isLikelyMath(latex)) {
            ranges.push({
              from: current.pos,
              to: closer.pos + closer.node.nodeSize,
              node: blockType.create({ latex }),
            });
            i = j + 1;
            continue;
          }
        }
      }
      walk(current.node, current.pos + 1);
      i += 1;
    }
  };
  walk(doc, 0);
  ranges.sort((a, b) => b.from - a.from);
  return ranges;
}
