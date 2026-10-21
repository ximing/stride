import { Extension, InputRule, PasteRule, mergeAttributes, type AnyExtension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, type EditorState } from '@tiptap/pm/state';
import { collectDisplayFences } from './math-fold';
import { mathPlainText } from './math-plain';
import {
  classifyLatexInput,
  findMathInText,
  normalizeMathHtml,
  stripMathDelimiters,
  type MathSpan,
} from './math-html';

type MathMatchData = { latex: string; display: boolean };

function latexOf(node: ProseMirrorNode): string {
  return typeof node.attrs.latex === 'string' ? node.attrs.latex : '';
}

function suffixSpan(text: string): MathSpan | null {
  const spans = findMathInText(text);
  const last = spans[spans.length - 1];
  if (!last || last.index + last.length !== text.length) return null;
  return last;
}

const DocInlineMath = InlineMath.extend({
  addInputRules() {
    return [];
  },

  addPasteRules() {
    return [];
  },

  renderHTML({ HTMLAttributes, node }) {
    const latex = latexOf(node);
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-type': 'inline-math' }),
      mathPlainText('inlineMath', latex) ?? '',
    ];
  },

  renderText({ node }) {
    return mathPlainText('inlineMath', latexOf(node)) ?? '';
  },

  extendNodeSchema(built) {
    if (built.name !== this.name) return {};
    return {
      leafText: (node: ProseMirrorNode) => mathPlainText('inlineMath', latexOf(node)) ?? '',
    };
  },
});

const DocBlockMath = BlockMath.extend({
  addInputRules() {
    return [];
  },

  addPasteRules() {
    return [];
  },

  renderHTML({ HTMLAttributes, node }) {
    const latex = latexOf(node);
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'block-math' }),
      mathPlainText('blockMath', latex) ?? '',
    ];
  },

  renderText({ node }) {
    return mathPlainText('blockMath', latexOf(node)) ?? '';
  },

  extendNodeSchema(built) {
    if (built.name !== this.name) return {};
    return {
      leafText: (node: ProseMirrorNode) => mathPlainText('blockMath', latexOf(node)) ?? '',
    };
  },
});

function insertMatchedMath(
  state: EditorState,
  range: { from: number; to: number },
  data: MathMatchData,
): void {
  const inlineType = state.schema.nodes.inlineMath;
  const blockType = state.schema.nodes.blockMath;
  if (!inlineType || !blockType || !data.latex) return;
  if (!data.display) {
    state.tr.replaceWith(range.from, range.to, inlineType.create({ latex: data.latex }));
    return;
  }
  const $from = state.doc.resolve(range.from);
  const entire = range.from === $from.start() && range.to === $from.end();
  if (
    entire &&
    $from.depth >= 1 &&
    $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), blockType)
  ) {
    state.tr.replaceWith($from.before(), $from.after(), blockType.create({ latex: data.latex }));
    return;
  }
  state.tr.replaceWith(range.from, range.to, inlineType.create({ latex: data.latex }));
}

type MathClick = (pos: number, kind: 'inline' | 'block', latex: string) => void

let mathClickHandler: MathClick | null = null

/** The open editor registers this so a click on a formula opens the edit prompt. */
export function setMathClickHandler(handler: MathClick | null): void {
  mathClickHandler = handler
}

function mathClick(kind: 'inline' | 'block') {
  return (node: ProseMirrorNode, pos: number) => {
    const latex = typeof node.attrs.latex === 'string' ? node.attrs.latex : ''
    mathClickHandler?.(pos, kind, latex)
  }
}

export const DocMathematics = Extension.create<{ katexOutput: 'html' | 'mathml' }>({
  name: 'docMathematics',

  addOptions() {
    return { katexOutput: 'html' as const };
  },

  addExtensions() {
    const output = this.options.katexOutput;
    // Model answers put Chinese inside `\boxed{}`. KaTeX can draw that text;
    // the default strict mode only warns once per character.
    const strict = (code: string): 'ignore' | 'warn' =>
      code === 'unicodeTextInMathMode' ? 'ignore' : 'warn';
    return [
      DocBlockMath.configure({
        katexOptions: { throwOnError: false, displayMode: true, output, strict },
        onClick: mathClick('block'),
      }),
      DocInlineMath.configure({
        katexOptions: { throwOnError: false, displayMode: false, output, strict },
        onClick: mathClick('inline'),
      }),
    ];
  },

  transformPastedHTML(html) {
    return normalizeMathHtml(html);
  },

  addInputRules() {
    return [
      new InputRule({
        find: (text) => {
          const span = suffixSpan(text);
          if (!span) return null;
          return {
            index: span.index,
            text: text.slice(span.index, span.index + span.length),
            data: { latex: span.latex, display: span.display },
          };
        },
        handler: ({ state, range, match }) => {
          const data = match.data as MathMatchData | undefined;
          if (!data?.latex) return null;
          insertMatchedMath(state, range, data);
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      new PasteRule({
        find: (text) =>
          findMathInText(text).map((span) => ({
            index: span.index,
            text: text.slice(span.index, span.index + span.length),
            data: { latex: span.latex, display: span.display } satisfies MathMatchData,
          })),
        handler: ({ state, range, match }) => {
          const data = match.data as MathMatchData | undefined;
          if (!data?.latex) return;
          insertMatchedMath(state, range, data);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _old, state) {
          if (transactions.some((tr) => tr.getMeta('mathFold'))) return null;
          const pasted = transactions.some((tr) => tr.getMeta('uiEvent') === 'paste');
          if (!pasted) return null;
          const ranges = collectDisplayFences(state.doc);
          if (ranges.length === 0) return null;
          const tr = state.tr;
          for (const range of ranges) tr.replaceWith(range.from, range.to, range.node);
          tr.setMeta('mathFold', true);
          return tr;
        },
      }),
    ];
  },
});

export function createDocMathExtensions(opts?: { output?: 'html' | 'mathml' }): AnyExtension[] {
  const output = opts?.output ?? 'html';
  if (output === 'html') return [DocMathematics];
  return [DocMathematics.configure({ katexOutput: output })];
}

export function insertMathLatex(editor: Editor, raw: string): boolean {
  const parsed = classifyLatexInput(raw);
  if (!parsed) return false;
  const chain = editor.chain().focus();
  if (parsed.kind === 'block') return chain.insertBlockMath({ latex: parsed.latex }).run();
  return chain.insertInlineMath({ latex: parsed.latex }).run();
}

export function updateMathLatex(
  editor: Editor,
  pos: number,
  kind: 'inline' | 'block',
  raw: string,
): boolean {
  const latex = stripMathDelimiters(raw).trim();
  const chain = editor.chain().focus().setNodeSelection(pos);
  if (!latex) {
    if (kind === 'block') return chain.deleteBlockMath({ pos }).run();
    return chain.deleteInlineMath({ pos }).run();
  }
  if (kind === 'block') return chain.updateBlockMath({ latex, pos }).run();
  return chain.updateInlineMath({ latex, pos }).run();
}
