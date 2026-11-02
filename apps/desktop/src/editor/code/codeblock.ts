import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { NodeSelection } from '@tiptap/pm/state'
import { common, createLowlight } from 'lowlight'
import { t, watchLocale } from '../../i18n'
import {
  CODE_FOLD_META,
  codeBlockCollapsedAttribute,
  codeBlockCollapsedOf,
  codeBlockFoldLabel,
  codeFoldTypingPlugin,
} from './code-fold'
import { registerDocCodeAliases } from './code-language'
import { attachCodeLanguageMenu } from './code-language-menu'

export let lastCopiedText = ''

const lowlight = createLowlight(common)
registerDocCodeAliases(lowlight)

type HastNode = {
  type: string
  value?: string
  properties?: { className?: string | string[] }
  children?: HastNode[]
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function hastToHtml(node: HastNode): string {
  if (node.type === 'text') return escapeHtml(node.value ?? '')
  const children = node.children?.map(hastToHtml).join('') ?? ''
  if (node.type !== 'element') return children
  const className = node.properties?.className
  const cls = Array.isArray(className) ? className.join(' ') : className ?? ''
  if (!cls) return `<span>${children}</span>`
  return `<span class="${escapeHtml(cls)}">${children}</span>`
}

function highlightHtml(language: unknown, text: string): string {
  if (typeof language !== 'string' || !language || !lowlight.registered(language)) return escapeHtml(text)
  try {
    return hastToHtml(lowlight.highlight(language, text) as HastNode)
  } catch {
    return escapeHtml(text)
  }
}

function foldChevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'm9 18 6-6-6-6')
  svg.append(path)
  return svg
}

export const codeBlockExtension = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      collapsed: codeBlockCollapsedAttribute(),
    }
  },

  // Decorations from the stock plugin run on every transaction. Highlight later, off the input path.
  addProseMirrorPlugins() {
    return [codeFoldTypingPlugin()]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      let destroyed = false
      let idleId: number | null = null
      let timerId: ReturnType<typeof setTimeout> | null = null
      let copiedId: ReturnType<typeof setTimeout> | null = null

      const dom = document.createElement('div')
      dom.className = 'editor-code'

      const head = document.createElement('div')
      head.className = 'editor-code-head'

      const tools = document.createElement('div')
      tools.className = 'editor-code-tools'

      const fold = document.createElement('button')
      fold.type = 'button'
      fold.className = 'editor-code-fold'
      fold.dataset.testid = 'code-fold'
      fold.setAttribute('aria-expanded', 'true')
      fold.append(foldChevron())

      const summary = document.createElement('div')
      summary.className = 'editor-code-summary'
      summary.dataset.testid = 'code-summary'
      summary.setAttribute('contenteditable', 'false')
      summary.hidden = true

      const select = document.createElement('button')
      select.dataset.testid = 'code-language'
      select.className = 'editor-code-lang'
      const languageMenu = attachCodeLanguageMenu({
        trigger: select,
        getLanguage: () => current.attrs.language,
        setLanguage: (value) => {
          const pos = getPos()
          if (typeof pos !== 'number') return
          editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            language: value,
          }))
        },
        isEditable: () => editor.isEditable,
      })

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'editor-code-copy'
      button.dataset.testid = 'code-copy'
      const applyCopy = () => {
        button.textContent = t('editor.copy')
      }
      applyCopy()
      const unwatchCopy = watchLocale(applyCopy)

      const frame = document.createElement('div')
      frame.className = 'editor-code-frame'

      const pre = document.createElement('pre')
      const code = document.createElement('code')
      pre.append(code)

      const overlay = document.createElement('pre')
      overlay.className = 'editor-code-overlay'
      overlay.setAttribute('aria-hidden', 'true')

      frame.append(pre, overlay)
      tools.append(fold, select, summary)
      head.append(tools, button)
      dom.append(head, frame)

      const readPos = (): number | null => {
        const pos = getPos()
        return typeof pos === 'number' ? pos : null
      }

      const setCollapsed = (next: boolean): void => {
        if (editor.isDestroyed) return
        const pos = readPos()
        if (pos === null) return
        const block = editor.state.doc.nodeAt(pos)
        if (!block || block.type.name !== 'codeBlock') return
        if (codeBlockCollapsedOf(block.attrs.collapsed) === next) return
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...block.attrs, collapsed: next })
        tr.setMeta(CODE_FOLD_META, true)
        if (next) {
          const mapped = tr.mapping.map(pos)
          const updated = tr.doc.nodeAt(mapped)
          const selection = tr.selection
          const inside = updated !== null && selection.from > mapped && selection.to < mapped + updated.nodeSize
          if (inside && updated) tr.setSelection(NodeSelection.create(tr.doc, mapped))
        }
        editor.view.dispatch(tr)
      }

      const paintFold = () => {
        const collapsed = codeBlockCollapsedOf(current.attrs.collapsed)
        dom.classList.toggle('is-collapsed', collapsed)
        fold.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
        fold.setAttribute('aria-label', t(collapsed ? 'editor.codeBlock.expand' : 'editor.codeBlock.fold'))
        summary.hidden = !collapsed
        summary.textContent = codeBlockFoldLabel(current.textContent)
        frame.hidden = collapsed
      }
      paintFold()
      const unwatchFold = watchLocale(paintFold)

      fold.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        setCollapsed(!codeBlockCollapsedOf(current.attrs.collapsed))
      })
      fold.addEventListener('click', (event) => {
        event.preventDefault()
      })
      fold.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        setCollapsed(!codeBlockCollapsedOf(current.attrs.collapsed))
      })

      // The overlay is absolutely positioned, so it does not follow the
      // editable pre's horizontal scroll on its own. Keep them aligned.
      pre.addEventListener('scroll', () => {
        overlay.scrollLeft = pre.scrollLeft
      })

      const cancel = () => {
        if (idleId != null && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId)
        idleId = null
        if (timerId != null) clearTimeout(timerId)
        timerId = null
      }

      const paint = () => {
        idleId = null
        timerId = null
        if (destroyed) return
        const html = highlightHtml(current.attrs.language, code.textContent ?? '')
        overlay.innerHTML = html
        // Glyphs live in the overlay. Hiding them with `color: transparent`
        // also hides the caret on macOS, so the CSS class uses text-fill.
        code.classList.toggle('is-highlighted', html.length > 0)
      }

      const schedule = () => {
        cancel()
        if (typeof requestIdleCallback === 'function') {
          idleId = requestIdleCallback(() => {
            idleId = null
            paint()
          })
          return
        }
        timerId = setTimeout(() => {
          timerId = null
          paint()
        }, 16)
      }

      button.addEventListener('click', () => {
        const text = code.textContent ?? ''
        lastCopiedText = text
        const clipboard = navigator.clipboard
        if (!clipboard || typeof clipboard.writeText !== 'function') return
        try {
          const pending = clipboard.writeText(text)
          if (pending && typeof pending.then === 'function') {
            pending.then(() => {
              if (destroyed) return
              button.textContent = t('editor.copied')
              if (copiedId != null) clearTimeout(copiedId)
              copiedId = setTimeout(() => {
                copiedId = null
                if (!destroyed) button.textContent = t('editor.copy')
              }, 1200)
            }, () => {})
          }
        } catch {
          // clipboard can throw when the document is not focused
        }
      })

      schedule()

      // Opening a document can leave the caret in a hidden block. Select the block instead.
      queueMicrotask(() => {
        if (destroyed || editor.isDestroyed || !editor.isEditable) return
        const pos = readPos()
        if (pos === null) return
        const block = editor.state.doc.nodeAt(pos)
        if (!block || block.type.name !== 'codeBlock' || !codeBlockCollapsedOf(block.attrs.collapsed)) return
        const selection = editor.state.selection
        const inside = selection.from > pos && selection.to < pos + block.nodeSize
        if (!inside) return
        const tr = editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos))
        tr.setMeta('addToHistory', false)
        editor.view.dispatch(tr)
      })

      return {
        dom,
        contentDOM: code,
        update(updated) {
          if (updated.type.name !== current.type.name) return false
          current = updated
          languageMenu.sync()
          paintFold()
          schedule()
          return true
        },
        ignoreMutation(mutation) {
          if (mutation.type === 'selection') return false
          const target = mutation.target
          if (target === code) return mutation.type === 'attributes'
          if (target instanceof globalThis.Node && code.contains(target)) return false
          return true
        },
        stopEvent(event) {
          const target = event.target
          return (
            target instanceof globalThis.Node &&
            (select.contains(target) || button.contains(target) || fold.contains(target) || summary.contains(target))
          )
        },
        destroy() {
          destroyed = true
          unwatchCopy()
          unwatchFold()
          languageMenu.destroy()
          cancel()
          if (copiedId != null) clearTimeout(copiedId)
          copiedId = null
        },
      }
    }
  },
}).configure({ lowlight })
