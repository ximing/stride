import { MathMLToLaTeX } from 'mathml-to-latex';

const MAX_LATEX = 4000;
const CURRENCY = /^[\d,.\s]+$/;
const MATH_SIGNAL = /[\\^_=+*/<>{}[\]|]/;
const SKIP_TAGS = new Set(['pre', 'code', 'script', 'style', 'textarea']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export type MathSpan = {
  index: number;
  length: number;
  latex: string;
  display: boolean;
};

export function decodeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return entity;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Currency-like `$100$` stays text. Spaced prose stays text. Real TeX passes. */
export function isLikelyMath(latex: string): boolean {
  const trimmed = latex.trim();
  if (!trimmed || trimmed.length > MAX_LATEX) return false;
  if (CURRENCY.test(trimmed)) return false;
  if (!/\s/.test(trimmed)) return true;
  return MATH_SIGNAL.test(trimmed);
}

export { mathPlainText } from './math-plain';

/** User-typed LaTeX from the formula dialog. Empty means delete. */
export function stripMathDelimiters(raw: string): string {
  const trimmed = raw.trim();
  const block = /^\$\$([\s\S]*)\$\$$/.exec(trimmed);
  if (block?.[1] !== undefined) return block[1].trim();
  const bracket = /^\\\[([\s\S]*)\\\]$/.exec(trimmed);
  if (bracket?.[1] !== undefined) return bracket[1].trim();
  const paren = /^\\\(([\s\S]*)\\\)$/.exec(trimmed);
  if (paren?.[1] !== undefined) return paren[1].trim();
  if (
    trimmed.startsWith('$') &&
    trimmed.endsWith('$') &&
    trimmed.length >= 2 &&
    !trimmed.startsWith('$$')
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function classifyLatexInput(raw: string): { kind: 'inline' | 'block'; latex: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const display =
    trimmed.startsWith('$$') || trimmed.startsWith('\\[') || trimmed.includes('\n');
  const latex = stripMathDelimiters(trimmed).trim();
  if (!latex) return null;
  return { kind: display ? 'block' : 'inline', latex };
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findMarker(text: string, from: number, marker: string): number {
  const at = text.indexOf(marker, from);
  if (at < 0 || at - from > MAX_LATEX) return -1;
  return at;
}

function findSingleDollar(text: string, from: number): number {
  for (let i = from; i < text.length && i - from <= MAX_LATEX; i += 1) {
    if (text[i] !== '$' || isEscaped(text, i)) continue;
    if (text[i - 1] === '$' || text[i + 1] === '$') continue;
    return i;
  }
  return -1;
}

/** Markdown delimiters in a plain string: `$$`, `\[ \]`, `\( \)`, `$`. */
export function findMathInText(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('$$', i) && !isEscaped(text, i)) {
      const close = findMarker(text, i + 2, '$$');
      if (close > i) {
        const inner = text.slice(i + 2, close);
        const latex = inner.trim();
        if (latex && isLikelyMath(latex)) {
          spans.push({ index: i, length: close + 2 - i, latex, display: true });
          i = close + 2;
          continue;
        }
      }
    }
    if (text.startsWith('\\[', i)) {
      const close = findMarker(text, i + 2, '\\]');
      if (close > i) {
        const latex = text.slice(i + 2, close).trim();
        if (latex && isLikelyMath(latex)) {
          spans.push({ index: i, length: close + 2 - i, latex, display: true });
          i = close + 2;
          continue;
        }
      }
    }
    if (text.startsWith('\\(', i)) {
      const close = findMarker(text, i + 2, '\\)');
      if (close > i) {
        const inner = text.slice(i + 2, close);
        if (inner === inner.trim() && inner && !inner.includes('\n') && isLikelyMath(inner)) {
          spans.push({ index: i, length: close + 2 - i, latex: inner, display: false });
          i = close + 2;
          continue;
        }
      }
    }
    if (text[i] === '$' && !isEscaped(text, i) && text[i + 1] !== '$') {
      const close = findSingleDollar(text, i + 1);
      if (close > i) {
        const inner = text.slice(i + 1, close);
        if (inner === inner.trim() && inner && !inner.includes('\n') && isLikelyMath(inner)) {
          spans.push({ index: i, length: close + 1 - i, latex: inner, display: false });
          i = close + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  return spans;
}

function mathElement(latex: string, display: boolean): string {
  const attr = escapeAttr(latex);
  if (display) return `<div data-type="block-math" data-latex="${attr}"></div>`;
  return `<span data-type="inline-math" data-latex="${attr}"></span>`;
}

function findTagEnd(html: string, openAt: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = openAt + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function tagNameOf(tag: string): string {
  const match = /^<\/?\s*([^\s/>]+)/.exec(tag);
  return (match?.[1] ?? '').toLowerCase();
}

function isClosingTag(tag: string): boolean {
  return /^<\s*\//.test(tag);
}

function isSelfClosing(tag: string): boolean {
  return /\/\s*>$/.test(tag);
}

function attributeText(tag: string): string {
  return tag.replace(/^<\s*\/?\s*[^\s/>]+/, '').replace(/\/\s*>$/, '').replace(/>$/, '');
}

function attrValue(attrs: string, key: string): string | null {
  const match = new RegExp(
    `\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(attrs);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? null : decodeHtml(value);
}

function classTokens(attrs: string): string[] {
  return (attrValue(attrs, 'class') ?? '').split(/\s+/).filter((token) => token.length > 0);
}

function elementBounds(html: string, openAt: number): { end: number } | null {
  const openEnd = findTagEnd(html, openAt);
  if (openEnd < 0) return null;
  const openTag = html.slice(openAt, openEnd + 1);
  const name = tagNameOf(openTag);
  if (!name || isClosingTag(openTag)) return null;
  if (isSelfClosing(openTag)) return { end: openEnd + 1 };
  let depth = 1;
  let i = openEnd + 1;
  while (i < html.length && depth > 0) {
    if (html.startsWith('<!--', i)) {
      const commentEnd = html.indexOf('-->', i + 4);
      i = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const lt = html.indexOf('<', i);
    if (lt < 0) return null;
    const gt = findTagEnd(html, lt);
    if (gt < 0) return null;
    const token = html.slice(lt, gt + 1);
    if (tagNameOf(token) === name && !isSelfClosing(token)) {
      if (isClosingTag(token)) depth -= 1;
      else depth += 1;
    }
    i = gt + 1;
    if (depth === 0) return { end: i };
  }
  return null;
}

function extractTexAnnotation(fragment: string): string | null {
  const re = /<annotation\b([^>]*)>([\s\S]*?)<\/annotation>/gi;
  let match: RegExpExecArray | null = re.exec(fragment);
  while (match) {
    const encoding = (attrValue(match[1] ?? '', 'encoding') ?? '').toLowerCase();
    if (encoding === 'application/x-tex') {
      const latex = decodeHtml(match[2] ?? '').trim();
      if (latex) return latex;
    }
    match = re.exec(fragment);
  }
  return null;
}

function isMathWidget(name: string, attrs: string): boolean {
  if (name === 'math' || name === 'mjx-container') return true;
  if (name === 'script') return /^math\/tex/i.test(attrValue(attrs, 'type') ?? '');
  if (name === 'span' || name === 'div') {
    const classes = classTokens(attrs);
    return (
      classes.includes('katex') || classes.includes('katex-display') || classes.includes('MathJax')
    );
  }
  return false;
}

function widgetIsDisplay(name: string, attrs: string): boolean {
  if (classTokens(attrs).includes('katex-display')) return true;
  const display = (attrValue(attrs, 'display') ?? '').toLowerCase();
  if (display === 'block' || display === 'true') return true;
  const type = attrValue(attrs, 'type') ?? '';
  if (/mode\s*=\s*display/i.test(type)) return true;
  if (name === 'math' && display === 'block') return true;
  return false;
}

function extractWidgetLatex(name: string, attrs: string, chunk: string): string | null {
  if (name === 'script') {
    const inner = chunk.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
    const latex = decodeHtml(inner).trim();
    return latex || null;
  }
  const annotated = extractTexAnnotation(chunk);
  if (annotated) return annotated;
  const alt = (attrValue(attrs, 'alttext') ?? '').trim();
  if (alt) return alt;
  if (name === 'math') {
    try {
      const latex = MathMLToLaTeX.convert(chunk).trim();
      return latex || null;
    } catch {
      return null;
    }
  }
  return null;
}

function replaceMathWidgets(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const commentEnd = html.indexOf('-->', lt + 4);
      const to = commentEnd < 0 ? html.length : commentEnd + 3;
      out += html.slice(lt, to);
      i = to;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      out += html.slice(lt);
      break;
    }
    const openTag = html.slice(lt, gt + 1);
    const name = tagNameOf(openTag);
    const attrs = attributeText(openTag);
    if (!name || isClosingTag(openTag) || !isMathWidget(name, attrs)) {
      out += openTag;
      i = gt + 1;
      continue;
    }
    const bounds = elementBounds(html, lt);
    if (!bounds) {
      out += openTag;
      i = gt + 1;
      continue;
    }
    const chunk = html.slice(lt, bounds.end);
    const latex = extractWidgetLatex(name, attrs, chunk);
    if (!latex) {
      out += openTag;
      i = gt + 1;
      continue;
    }
    out += mathElement(latex, widgetIsDisplay(name, attrs));
    i = bounds.end;
  }
  return out;
}

function htmlToPlain(html: string): string {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

function wrapDisplayInner(full: string, inner: string): string {
  if (/data-type\s*=\s*["'](?:inline|block)-math["']/.test(inner)) return full;
  const latex = htmlToPlain(inner).trim();
  if (!isLikelyMath(latex)) return full;
  return mathElement(latex, true);
}

function replaceDisplayBlocks(html: string): string {
  let out = html.replace(
    /<p\b[^>]*>\s*\$\$\s*<\/p>\s*([\s\S]*?)<p\b[^>]*>\s*\$\$\s*<\/p>/gi,
    (full, inner: string) => wrapDisplayInner(full, inner),
  );
  out = out.replace(
    /<p\b[^>]*>\s*\\\[\s*<\/p>\s*([\s\S]*?)<p\b[^>]*>\s*\\\]\s*<\/p>/gi,
    (full, inner: string) => wrapDisplayInner(full, inner),
  );
  out = out.replace(
    /<p\b[^>]*>\s*\$\$\s*(?:<br\s*\/?>\s*)+([\s\S]*?)(?:<br\s*\/?>\s*)+\$\$\s*<\/p>/gi,
    (full, inner: string) => wrapDisplayInner(full, inner),
  );
  out = out.replace(
    /<p\b[^>]*>\s*\\\[\s*(?:<br\s*\/?>\s*)+([\s\S]*?)(?:<br\s*\/?>\s*)+\\\]\s*<\/p>/gi,
    (full, inner: string) => wrapDisplayInner(full, inner),
  );
  return out;
}

function skipTag(name: string, attrs: string): boolean {
  if (SKIP_TAGS.has(name)) return true;
  const dataType = attrValue(attrs, 'data-type');
  return dataType === 'inline-math' || dataType === 'block-math';
}

function spliceMath(text: string): string {
  const spans = findMathInText(text);
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.index);
    out += mathElement(span.latex, span.display);
    cursor = span.index + span.length;
  }
  out += text.slice(cursor);
  return out;
}

function replaceTextDelimiters(html: string): string {
  let out = '';
  let i = 0;
  const stack: { name: string; skip: boolean }[] = [];
  const skipping = (): boolean => stack.some((frame) => frame.skip);
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const commentEnd = html.indexOf('-->', i + 4);
      const to = commentEnd < 0 ? html.length : commentEnd + 3;
      out += html.slice(i, to);
      i = to;
      continue;
    }
    if (html[i] === '<') {
      const gt = findTagEnd(html, i);
      if (gt < 0) {
        out += html.slice(i);
        break;
      }
      const token = html.slice(i, gt + 1);
      const name = tagNameOf(token);
      if (name && !isSelfClosing(token)) {
        if (isClosingTag(token)) {
          for (let frame = stack.length - 1; frame >= 0; frame -= 1) {
            if (stack[frame]?.name === name) {
              stack.splice(frame, 1);
              break;
            }
          }
        } else {
          stack.push({ name, skip: skipTag(name, attributeText(token)) });
        }
      }
      out += token;
      i = gt + 1;
      continue;
    }
    const next = html.indexOf('<', i);
    const text = html.slice(i, next < 0 ? html.length : next);
    out += skipping() ? text : spliceMath(text);
    i = next < 0 ? html.length : next;
  }
  return out;
}

/**
 * Turn pasted or imported HTML into TipTap math nodes:
 * KaTeX / MathJax annotations, MathML, and `$` / `$$` / `\(\)` / `\[\]`.
 */
export function normalizeMathHtml(html: string): string {
  if (!html) return html;
  let out = html;
  if (/katex|mjx-container|<math\b|math\/tex/i.test(out)) out = replaceMathWidgets(out);
  if (/\$\$|\\\[/.test(out)) out = replaceDisplayBlocks(out);
  if (/\$|\\\(|\\\[/.test(out)) out = replaceTextDelimiters(out);
  return out;
}
