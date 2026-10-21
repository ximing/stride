import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'
import { t, watchLocale } from '../../i18n'
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

export const codeBlockExtension = CodeBlockLowlight.extend({
  // Decorations from the stock plugin run on every transaction. Highlight later, off the input path.
  addProseMirrorPlugins() {
    return []
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      let destroyed = false
      let idleId: number | null = null
      let timerId: ReturnType<typeof setTimeout> | null = null

      const dom = document.createElement('div')
      dom.className = 'editor-code'

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
      frame.style.position = 'relative'

      const pre = document.createElement('pre')
      const code = document.createElement('code')
      pre.append(code)

      const overlay = document.createElement('pre')
      overlay.className = 'editor-code-overlay'
      overlay.setAttribute('aria-hidden', 'true')

      frame.append(pre, overlay)
      dom.append(select, button, frame)

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
        if (html) {
          code.style.color = 'transparent'
          code.style.caretColor = 'var(--sd-fg)'
        } else {
          code.style.color = ''
          code.style.caretColor = ''
        }
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
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        } catch {
          // clipboard can throw when the document is not focused
        }
      })

      schedule()

      return {
        dom,
        contentDOM: code,
        update(updated) {
          if (updated.type.name !== current.type.name) return false
          current = updated
          languageMenu.sync()
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
          return target instanceof globalThis.Node && (select.contains(target) || button.contains(target))
        },
        destroy() {
          destroyed = true
          unwatchCopy()
          languageMenu.destroy()
          cancel()
        },
      }
    }
  },
}).configure({ lowlight })
