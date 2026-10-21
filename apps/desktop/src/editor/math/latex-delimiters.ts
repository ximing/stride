const MAX_LATEX = 8000;

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === '\n';
}

/** Past a fenced code block that opens at `index`, or `index` when this is not one. */
function skipFencedCode(text: string, index: number): number {
  if (!isLineStart(text, index)) return index;
  let i = index;
  let spaces = 0;
  while (spaces < 3 && text[i] === ' ') {
    spaces += 1;
    i += 1;
  }
  const marker = text[i];
  if (marker !== '`' && marker !== '~') return index;
  let size = 0;
  while (text[i + size] === marker) size += 1;
  if (size < 3) return index;
  const openEnd = text.indexOf('\n', i + size);
  if (openEnd < 0) return text.length;
  let line = openEnd + 1;
  while (line < text.length) {
    let j = line;
    let indent = 0;
    while (indent < 4 && text[j] === ' ') {
      indent += 1;
      j += 1;
    }
    if (indent < 4 && text[j] === marker) {
      let closeSize = 0;
      while (text[j + closeSize] === marker) closeSize += 1;
      if (closeSize >= size) {
        let k = j + closeSize;
        while (text[k] === ' ' || text[k] === '\t') k += 1;
        if (k === text.length) return k;
        if (text[k] === '\n') return k + 1;
      }
    }
    const next = text.indexOf('\n', line);
    if (next < 0) return text.length;
    line = next + 1;
  }
  return text.length;
}

/** Past an inline code span that opens at `index`, or `index` when this is not one. */
function skipInlineCode(text: string, index: number): number {
  if (text[index] !== '`') return index;
  let size = 0;
  while (text[index + size] === '`') size += 1;
  const close = text.indexOf('`'.repeat(size), index + size);
  if (close < 0) return index;
  return close + size;
}

function skipProtected(text: string, index: number): number {
  const fenced = skipFencedCode(text, index);
  if (fenced > index) return fenced;
  return skipInlineCode(text, index);
}

function isLatexOpener(text: string, index: number, bracket: '[' | '('): boolean {
  if (text[index] !== '\\' || text[index + 1] !== bracket) return false;
  return index === 0 || text[index - 1] !== '\\';
}

function findLatexCloser(text: string, from: number, bracket: ']' | ')'): number {
  const limit = Math.min(text.length, from + MAX_LATEX);
  for (let i = from; i < limit; i += 1) {
    const protectedEnd = skipProtected(text, i);
    if (protectedEnd > i) {
      i = protectedEnd - 1;
      continue;
    }
    if (text[i] === '\\' && text[i + 1] === bracket && text[i - 1] !== '\\') return i;
  }
  return -1;
}

/** The opener and closer sit on lines that contain nothing else. */
function ownsLines(text: string, open: number, closeEnd: number): boolean {
  for (let i = open - 1; i >= 0 && text[i] !== '\n'; i -= 1) {
    if (text[i] !== ' ' && text[i] !== '\t') return false;
  }
  for (let i = closeEnd; i < text.length && text[i] !== '\n'; i += 1) {
    if (text[i] !== ' ' && text[i] !== '\t') return false;
  }
  return true;
}

/**
 * Model markdown writes display math as `\[...\]` and inline math as `\(...\)`.
 * CommonMark treats those backslashes as escapes, so remark-math never sees a
 * formula. Rewrite them to `$` / `$$` outside code. A formula on its own line
 * becomes a display block; one inside a sentence stays inline.
 */
export function normalizeLatexMathDelimiters(markdown: string): string {
  let out = '';
  let i = 0;
  while (i < markdown.length) {
    const skipped = skipProtected(markdown, i);
    if (skipped > i) {
      out += markdown.slice(i, skipped);
      i = skipped;
      continue;
    }
    if (isLatexOpener(markdown, i, '[')) {
      const close = findLatexCloser(markdown, i + 2, ']');
      if (close > i) {
        const inner = markdown.slice(i + 2, close);
        const latex = inner.trim();
        const end = close + 2;
        if (latex && (inner.includes('\n') || ownsLines(markdown, i, end))) {
          const own = ownsLines(markdown, i, end);
          // A display block has to start a line. Drop the indent of an
          // own-line formula; otherwise break the prose in front of it off
          // into the previous paragraph.
          if (own) out = out.replace(/[ \t]*$/, '');
          else if (out.length > 0 && !out.endsWith('\n')) out += '\n\n';
          let next = end;
          while (next < markdown.length && markdown[next] !== '\n') next += 1;
          const tail = own ? '' : markdown.slice(end, next).trim();
          if (markdown[next] === '\n') next += 1;
          out += `$$\n${latex}\n$$\n`;
          if (tail) out += `\n${tail}\n`;
          i = next;
          continue;
        }
        if (latex && !inner.includes('\n')) {
          out += `$$${latex}$$`;
          i = end;
          continue;
        }
      }
    }
    if (isLatexOpener(markdown, i, '(')) {
      const close = findLatexCloser(markdown, i + 2, ')');
      if (close > i) {
        const inner = markdown.slice(i + 2, close);
        const latex = inner.trim();
        if (latex && !inner.includes('\n')) {
          out += `$${latex.replaceAll('$', '\\$')}$`;
          i = close + 2;
          continue;
        }
      }
    }
    out += markdown[i] ?? '';
    i += 1;
  }
  return out;
}
