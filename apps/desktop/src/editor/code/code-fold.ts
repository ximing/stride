import type { Attribute } from '@tiptap/core'
import { NodeSelection, Plugin, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { t } from '../../i18n'

/** Transaction meta for a code-block fold toggle. */
export const CODE_FOLD_META = 'codeFold'

/** Stored fold flag. Missing and unknown values stay expanded. */
export function codeBlockCollapsedOf(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * One-line label for a folded block. The first non-empty line stays visible,
 * and a longer block adds its line count.
 */
export function codeBlockFoldLabel(text: string): string {
  if (text.length === 0) return t('editor.codeBlock.empty')
  const lines = text.split('\n')
  const preview = lines.map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  if (lines.length <= 1) return preview || t('editor.codeBlock.empty')
  if (preview === '') return t('editor.codeBlock.lines', { count: lines.length })
  return t('editor.codeBlock.preview', { text: preview, count: lines.length })
}

export function codeBlockCollapsedAttribute(): Attribute {
  return {
    default: false,
    parseHTML: (element) => element.getAttribute('data-collapsed') === 'true',
    renderHTML: (attributes) =>
      codeBlockCollapsedOf(attributes.collapsed) ? { 'data-collapsed': 'true' } : {},
  }
}

/**
 * A collapsed code block selected as a whole must not be replaced by the next
 * key. Insert at the start and expand, or only expand and place the caret.
 */
export function collapsedCodeTypingTransaction(
  state: EditorState,
  action: { kind: 'insert'; text: string } | { kind: 'expand'; edge: 'start' | 'end' },
): Transaction | null {
  const selection = state.selection
  if (!(selection instanceof NodeSelection)) return null
  if (selection.node.type.name !== 'codeBlock') return null
  if (!codeBlockCollapsedOf(selection.node.attrs.collapsed)) return null
  const pos = selection.from
  let tr = state.tr
  let caret = pos + 1
  if (action.kind === 'insert') {
    if (action.text.length === 0) return null
    tr = tr.insertText(action.text, caret)
    caret += action.text.length
  } else if (action.edge === 'end') {
    const block = tr.doc.nodeAt(pos)
    if (!block) return null
    caret = pos + block.nodeSize - 1
  }
  const block = tr.doc.nodeAt(pos)
  if (!block || block.type.name !== 'codeBlock') return null
  tr = tr.setNodeMarkup(pos, null, { ...block.attrs, collapsed: false })
  tr.setMeta(CODE_FOLD_META, true)
  tr.setSelection(TextSelection.create(tr.doc, caret))
  return tr
}

/** Two spaces. Tab in a code block inserts this instead of moving focus. */
export const CODE_INDENT = '  '

interface LineSpan {
  start: number
  end: number
}

function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue
    spans.push({ start, end: index })
    start = index + 1
  }
  spans.push({ start, end: text.length })
  return spans
}

/** Lines covered by a selection inside one code block. An empty caret covers its own line. */
function linesInSelection(text: string, fromRel: number, toRel: number, empty: boolean): LineSpan[] {
  const spans = lineSpans(text)
  if (empty) return spans.filter((span) => fromRel >= span.start && fromRel <= span.end)
  return spans.filter((span) => span.start < toRel && span.end >= fromRel)
}

function isCodeNode(name: string, specCode: unknown): boolean {
  return specCode === true && (name === 'codeBlock' || name === 'mermaid')
}

/**
 * Tab inserts two spaces at the caret. A selection indents each covered line.
 * Shift-Tab removes up to two leading spaces from those lines.
 * Returns an unchanged transaction when the caret is in code but nothing can
 * be outdented, and null when the selection is not in a code block.
 */
export function codeIndentTransaction(
  state: EditorState,
  direction: 'indent' | 'outdent',
): Transaction | null {
  const { selection } = state
  if (selection instanceof NodeSelection) {
    if (!isCodeNode(selection.node.type.name, selection.node.type.spec.code)) return null
    return indentCodeText(
      state.tr,
      selection.from,
      selection.node.textContent,
      0,
      selection.node.textContent.length,
      false,
      direction,
    )
  }
  if (!(selection instanceof TextSelection)) return null
  const { $from, $to } = selection
  if (!isCodeNode($from.parent.type.name, $from.parent.type.spec.code)) return null
  if ($from.parent !== $to.parent) return null
  const start = $from.before()
  const fromRel = selection.from - $from.start()
  const toRel = selection.to - $from.start()
  if (selection.empty && direction === 'indent') {
    return state.tr.insertText(CODE_INDENT, selection.from)
  }
  return indentCodeText(state.tr, start, $from.parent.textContent, fromRel, toRel, selection.empty, direction)
}

function indentCodeText(
  tr: Transaction,
  nodePos: number,
  text: string,
  fromRel: number,
  toRel: number,
  empty: boolean,
  direction: 'indent' | 'outdent',
): Transaction {
  const contentStart = nodePos + 1
  const lines = linesInSelection(text, fromRel, toRel, empty)
  if (direction === 'indent') {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (!line) continue
      tr.insertText(CODE_INDENT, contentStart + line.start)
    }
    return tr
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line) continue
    const leading = text.slice(line.start, line.start + CODE_INDENT.length)
    const remove = leading.startsWith(CODE_INDENT) ? CODE_INDENT.length : leading.startsWith(' ') ? 1 : 0
    if (remove === 0) continue
    tr.delete(contentStart + line.start, contentStart + line.start + remove)
  }
  return tr
}

const CODE_CHROME = '.editor-code-fold, .editor-code-lang, .editor-code-copy, .editor-code-summary, .editor-code-menu, .doc-mermaid-mode, .doc-mermaid-modes'

function onCodeChrome(event: Event): boolean {
  const target: unknown = event.target
  const closest =
    target !== null && typeof target === 'object' && 'closest' in target
      ? (target as { closest?: unknown }).closest
      : undefined
  return typeof closest === 'function' && closest.call(target, CODE_CHROME) != null
}

/** Keeps typing, Backspace, Delete, and paste from replacing a folded code block. */
export function codeFoldTypingPlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, _from, _to, text) {
        const tr = collapsedCodeTypingTransaction(view.state, { kind: 'insert', text })
        if (!tr) return false
        view.dispatch(tr)
        return true
      },
      handleKeyDown(view, event) {
        if (event.key === 'Tab' && view.editable && !onCodeChrome(event)) {
          const tr = codeIndentTransaction(view.state, event.shiftKey ? 'outdent' : 'indent')
          if (tr) {
            if (tr.docChanged) view.dispatch(tr)
            return true
          }
        }
        if (event.key !== 'Backspace' && event.key !== 'Delete') return false
        const tr = collapsedCodeTypingTransaction(view.state, {
          kind: 'expand',
          edge: event.key === 'Delete' ? 'end' : 'start',
        })
        if (!tr) return false
        view.dispatch(tr)
        return true
      },
      handlePaste(view) {
        const tr = collapsedCodeTypingTransaction(view.state, { kind: 'expand', edge: 'end' })
        if (!tr) return false
        view.dispatch(tr)
        return false
      },
    },
  })
}
