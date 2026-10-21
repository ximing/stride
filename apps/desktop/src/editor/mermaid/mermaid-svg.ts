/** Reject SVG that could run script after it is inserted into the document. */
const UNSAFE_SVG =
  /<\s*(?:script|iframe|object|embed)\b|\son[a-z][\w:-]*\s*=|javascript\s*:|data\s*:\s*text\/html/i;

export function mermaidSvgLooksUnsafe(svg: string): boolean {
  return UNSAFE_SVG.test(svg);
}
