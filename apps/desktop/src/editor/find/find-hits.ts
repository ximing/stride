import type { Mark, Node as PmNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { t } from '../../i18n';

/**
 * 正文里按关键字能搜到字的原子节点。命中落在属性字符串上，高亮整颗节点。
 * 公式存的是 LaTeX，图片存的是替代文本。
 */
const ATOM_TEXT_ATTRS: Record<string, string> = {
  inlineMath: 'latex',
  blockMath: 'latex',
  image: 'alt',
};

export type FindHit = {
  from: number;
  to: number;
  kind: 'text' | 'attr';
  attr: string | null;
  attrFrom: number;
  attrTo: number;
};

export type FindQuery = {
  query: string;
  caseSensitive: boolean;
};

/**
 * 按 UTF-16 码元折叠，和 ProseMirror 位置对齐。
 * 个别字符折叠后会变长（如 İ），这种码元保持原样，避免命中区间错位。
 */
export function foldForMatch(text: string, caseSensitive: boolean): string {
  if (caseSensitive || text.length === 0) return text;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? lower : ch;
  }
  return out;
}

/** 不重叠、从左到右。下标是原字符串的 UTF-16 偏移。 */
export function keywordSpans(text: string, query: FindQuery): Array<{ start: number; end: number }> {
  if (query.query.length === 0) return [];
  const hay = foldForMatch(text, query.caseSensitive);
  const needle = foldForMatch(query.query, query.caseSensitive);
  if (needle.length === 0 || needle.length > hay.length) return [];
  const spans: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    spans.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return spans;
}

function pushTextHits(hits: FindHit[], text: string, pmFrom: number, query: FindQuery): void {
  for (const span of keywordSpans(text, query)) {
    hits.push({
      from: pmFrom + span.start,
      to: pmFrom + span.end,
      kind: 'text',
      attr: null,
      attrFrom: 0,
      attrTo: 0,
    });
  }
}

function pushAttrHits(hits: FindHit[], node: PmNode, pos: number, attr: string, query: FindQuery): void {
  const value = node.attrs[attr];
  if (typeof value !== 'string' || value.length === 0) return;
  for (const span of keywordSpans(value, query)) {
    hits.push({
      from: pos,
      to: pos + node.nodeSize,
      kind: 'attr',
      attr,
      attrFrom: span.start,
      attrTo: span.end,
    });
  }
}

function searchInlines(node: PmNode, contentPos: number, query: FindQuery, hits: FindHit[]): void {
  let buffer = '';
  let bufferFrom = 0;
  let open = false;
  const flush = () => {
    if (!open) return;
    pushTextHits(hits, buffer, bufferFrom, query);
    open = false;
    buffer = '';
  };
  node.forEach((child, offset) => {
    const childPos = contentPos + offset;
    if (child.isText) {
      const text = child.text ?? '';
      if (!open) {
        open = true;
        bufferFrom = childPos;
        buffer = text;
      } else if (bufferFrom + buffer.length === childPos) {
        buffer += text;
      } else {
        flush();
        open = true;
        bufferFrom = childPos;
        buffer = text;
      }
      return;
    }
    flush();
    const attr = ATOM_TEXT_ATTRS[child.type.name];
    if (attr && child.isAtom) {
      pushAttrHits(hits, child, childPos, attr, query);
      return;
    }
    if (child.inlineContent) searchInlines(child, childPos + 1, query, hits);
  });
  flush();
}

function contentStart(pos: number): number {
  return pos < 0 ? 0 : pos + 1;
}

function searchBlocks(node: PmNode, pos: number, query: FindQuery, hits: FindHit[]): void {
  const attr = ATOM_TEXT_ATTRS[node.type.name];
  if (attr && node.isAtom && pos >= 0) {
    pushAttrHits(hits, node, pos, attr, query);
    return;
  }
  if (node.isTextblock) {
    searchInlines(node, contentStart(pos), query, hits);
    return;
  }
  const start = contentStart(pos);
  node.forEach((child, offset) => {
    searchBlocks(child, start + offset, query, hits);
  });
}

/** 关键字匹配。不跨段落；同一段里被加粗拆开的文字仍算连续。 */
export function findKeywordHits(doc: PmNode, query: string, caseSensitive: boolean): FindHit[] {
  if (query.length === 0) return [];
  const hits: FindHit[] = [];
  searchBlocks(doc, -1, { query, caseSensitive }, hits);
  return hits;
}

export function findResultLabel(index: number, total: number, query: string): string {
  if (query.length === 0) return '';
  if (total <= 0) return t('editor.find.none');
  const current = Math.min(Math.max(index, 0), total - 1) + 1;
  return `${current}/${total}`;
}

/** 选区是一段不太长、不跨块的文字时，用它当查找词。 */
export function findSeedFromSelection(doc: PmNode, from: number, to: number): string | null {
  if (from === to || to < from || to - from > 80) return null;
  const text = doc.textBetween(from, to, '\n');
  if (text.length === 0 || text.length > 80 || text.includes('\n')) return null;
  return text;
}

function marksAt(doc: PmNode, from: number, to: number): readonly Mark[] {
  if (from >= to) return [];
  const pos = Math.min(from + 1, to, doc.content.size);
  if (pos <= 0) return [];
  return doc.resolve(pos).marks();
}

export function applyHitReplace(tr: Transaction, hit: FindHit, replacement: string): void {
  if (hit.kind === 'attr') {
    if (!hit.attr) return;
    const node = tr.doc.nodeAt(hit.from);
    if (!node || node.type.name === 'text') return;
    const value = node.attrs[hit.attr];
    if (typeof value !== 'string') return;
    const next = value.slice(0, hit.attrFrom) + replacement + value.slice(hit.attrTo);
    tr.setNodeMarkup(hit.from, null, { ...node.attrs, [hit.attr]: next });
    return;
  }
  if (hit.from >= hit.to) return;
  if (replacement.length === 0) {
    tr.delete(hit.from, hit.to);
    return;
  }
  const schema = tr.doc.type.schema;
  const marks = marksAt(tr.doc, hit.from, hit.to);
  try {
    tr.replaceWith(hit.from, hit.to, schema.text(replacement, marks));
  } catch {
    tr.replaceWith(hit.from, hit.to, schema.text(replacement));
  }
}

/** 从后往前替换，前面的位置不用重映射。同一事务，一次撤销。 */
export function applyHitsReplace(tr: Transaction, hits: readonly FindHit[], replacement: string): void {
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    applyHitReplace(tr, hits[i]!, replacement);
  }
}

/**
 * 替换后跳到插入内容之后的下一处，避免「a → a」停在刚写上的同一处。
 * 没有更后面的命中时回到第一处。
 */
export function nextHitIndex(
  hits: readonly FindHit[],
  replaced: FindHit,
  replacementLength: number,
  mappedEnd: number,
): number {
  if (hits.length === 0) return 0;
  const index = hits.findIndex((hit) => {
    if (replaced.kind === 'attr' && hit.kind === 'attr' && hit.from === replaced.from) {
      return hit.attrFrom >= replaced.attrFrom + replacementLength;
    }
    return hit.from >= mappedEnd;
  });
  return index >= 0 ? index : 0;
}
