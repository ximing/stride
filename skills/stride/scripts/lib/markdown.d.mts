// Type declarations for markdown.mjs so TypeScript consumers (the editor
// paste tests) can import the converter without implicit-any errors.

export interface MarkdownWarning {
  code: string
  message: string
}

export interface BuildNoteOptions {
  title?: string
  type?: string
  fallbackTitle?: string
}

export interface BuiltNote {
  document: {
    format: string
    title: string
    type: string
    properties?: Record<string, unknown>
    doc: { type: 'doc'; content: unknown[] }
  }
  warnings: MarkdownWarning[]
  titleSource: string
  typeSource: string
}

export function normalizeLatexMathDelimiters(markdown: string): string
export function parseFragment(markdown: string): { blocks: unknown[]; warnings: MarkdownWarning[] }
export function buildNote(markdown: string, options?: BuildNoteOptions): BuiltNote
