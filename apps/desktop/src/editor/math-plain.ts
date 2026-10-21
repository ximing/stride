/** Plain-text form of a math node. No MathML parser and no KaTeX. */
export function mathPlainText(type: string, latex: string): string | null {
  if (type !== 'inlineMath' && type !== 'blockMath') return null;
  const trimmed = latex.trim();
  if (!trimmed) return '';
  return type === 'blockMath' ? `$$\n${trimmed}\n$$` : `$${trimmed}$`;
}
