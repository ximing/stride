import { Node, mergeAttributes, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { t, watchLocale } from '../../i18n'
import { imeBlocksEnterFromEvent, runAfterImeEnter } from '../ime-enter'
import { insertMindMap } from './mindmap-insert'
import {
  addChild,
  addSibling,
  deleteTopic,
  findTopic,
  normalizeMindMap,
  parentTopicId,
  renameTopic,
  type MindMapTopic,
} from './tree'

export const mindMapSlashCommand = {
  id: 'mindMap',
  title: 'Mind map',
  keywords: 'mind map mindmap 脑图 思维导图',
  run(editor: Editor) {
    insertMindMap(editor)
  },
}

function readPos(getPos: () => number | undefined): number | null {
  const pos = getPos()
  return typeof pos === 'number' ? pos : null
}

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  if (target instanceof globalThis.Node) return target.parentElement
  return null
}

type HistoryKind = 'undo' | 'redo'
type HistoryRun = (kind: HistoryKind) => void

const historyByInput = new WeakMap<HTMLInputElement, HistoryRun>()
let lastTopic: HTMLInputElement | null = null

function rememberTopicFocus(event: Event) {
  const target = event.target
  if (!(target instanceof Element)) return
  if (target instanceof HTMLInputElement && target.classList.contains('mindmap-topic')) {
    lastTopic = target
    return
  }
  // The native Edit menu moves focus to the document while the topic stays current.
  if (target === document.body || target === document.documentElement) return
  const host = lastTopic?.closest('[data-testid="mindmap"]')
  if (host?.contains(target)) return
  lastTopic = null
}

/** Document undo/redo for a focused mind-map topic. False lets the host use the field's own history. */
export function applyMindMapMenuHistory(kind: HistoryKind): boolean {
  const active = document.activeElement
  let topic: HTMLInputElement | null = null
  if (active instanceof HTMLInputElement && active.classList.contains('mindmap-topic')) {
    topic = active
  } else if (lastTopic?.isConnected) {
    const host = lastTopic.closest('[data-testid="mindmap"]')
    const leftTheMap =
      active instanceof Element &&
      active !== document.body &&
      active !== document.documentElement &&
      !host?.contains(active)
    if (!leftTheMap) topic = lastTopic
  }
  if (!topic) return false
  const run = historyByInput.get(topic)
  if (!run) return false
  run(kind)
  return true
}

type MindMapHistoryWindow = Window & { __strideMindMapHistory?: (kind: string) => boolean }

function publishMindMapMenuHistory() {
  const target = window as MindMapHistoryWindow
  target.__strideMindMapHistory = (kind: string) => {
    if (kind !== 'undo' && kind !== 'redo') return false
    return applyMindMapMenuHistory(kind)
  }
  document.addEventListener('focusin', rememberTopicFocus)
}

publishMindMapMenuHistory()

function topicSelector(id: string): string {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id
  return `[data-topic-id="${escaped}"]`
}

function topicIds(root: MindMapTopic): string[] {
  return [root.id, ...root.children.flatMap((child) => topicIds(child))]
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function childByClass(parent: Element, className: string): HTMLElement | null {
  for (const child of parent.children) {
    if (child instanceof HTMLElement && child.classList.contains(className)) return child
  }
  return null
}

function topicPill(input: HTMLInputElement): HTMLElement {
  const parent = input.parentElement
  if (parent instanceof HTMLElement && parent.classList.contains('mindmap-pill')) return parent
  return input
}

/** Width of the glyphs the input will actually draw, including CJK fallback. */
function measureTextWidth(input: HTMLInputElement, text: string): number {
  const style = getComputedStyle(input)
  const fallback = [...text].length * (parseFloat(style.fontSize) || 16)
  const body = input.ownerDocument?.body
  if (!body) return fallback
  const probe = body.ownerDocument.createElement('span')
  probe.textContent = text || ' '
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;padding:0;border:0;margin:0;'
  // The font shorthand often serializes as "" when the family is a list, so copy longhands.
  probe.style.fontStyle = style.fontStyle
  probe.style.fontVariant = style.fontVariant
  probe.style.fontWeight = style.fontWeight
  probe.style.fontSize = style.fontSize
  probe.style.lineHeight = style.lineHeight
  probe.style.fontFamily = style.fontFamily
  probe.style.letterSpacing = style.letterSpacing
  body.append(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width > 0 ? width : fallback
}

/** Visual box the connector should meet. The border lives on the pill, not the input. */
function topicBox(node: Element): HTMLElement | null {
  const row = childByClass(node, 'mindmap-row')
  if (!row) return null
  const pill = childByClass(row, 'mindmap-pill')
  if (pill) return pill
  const input = row.querySelector('.mindmap-topic')
  return input instanceof HTMLElement ? input : null
}

function fitTopic(input: HTMLInputElement) {
  const text = input.value || input.placeholder || ' '
  const pill = topicPill(input)
  const box = getComputedStyle(pill)
  const pad = (parseFloat(box.paddingLeft) || 0) + (parseFloat(box.paddingRight) || 0)
  const border = (parseFloat(box.borderLeftWidth) || 0) + (parseFloat(box.borderRightWidth) || 0)
  const textWidth = measureTextWidth(input, text)
  const max = parseFloat(box.maxWidth)
  const width = Math.max(96, Math.ceil(textWidth + pad + border + 4))
  pill.style.width = `${Number.isFinite(max) ? Math.min(width, max) : width}px`
}

/** Mod-z / Mod-Shift-z / Mod-y. The field must not use the input's own undo stack. */
function historyCommand(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (event.altKey || event.isComposing || event.keyCode === 229) return null
  const key = event.key.toLowerCase()
  const mod = (event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey)
  if (!mod) return null
  if (key === 'y' && !event.shiftKey) return 'redo'
  if (key !== 'z') return null
  return event.shiftKey ? 'redo' : 'undo'
}

function compositionInput(event: Event): boolean {
  if (!(event instanceof InputEvent)) return false
  return event.isComposing || event.inputType === 'insertCompositionText'
}

function restoreSelection(input: HTMLInputElement, prev: string, start: number, end: number) {
  const next = input.value
  const map = (offset: number) => {
    if (prev.length === 0) return next.length
    return Math.min(next.length, Math.max(0, Math.round((offset / prev.length) * next.length)))
  }
  const from = map(start)
  const to = map(end)
  try {
    input.setSelectionRange(Math.min(from, to), Math.max(from, to))
  } catch {
    // Detached inputs in jsdom can refuse a selection range.
  }
}

function deleteIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('aria-hidden', 'true')
  icon.classList.add('mindmap-delete-icon')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M18 6 6 18M6 6l12 12')
  icon.append(path)
  return icon
}

export const mindMapNode = Node.create({
  name: 'mindMap',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  defining: true,

  addAttributes() {
    return {
      tree: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute('data-tree')
          if (!raw) return null
          try {
            return normalizeMindMap(JSON.parse(raw))
          } catch {
            return null
          }
        },
        renderHTML: (attributes) => {
          if (!attributes.tree) return {}
          return { 'data-tree': JSON.stringify(normalizeMindMap(attributes.tree)) }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-mindmap]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-mindmap': '', class: 'mindmap' })]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'mindmap'
      dom.dataset.testid = 'mindmap'
      dom.setAttribute('data-mindmap', '')
      dom.setAttribute('contenteditable', 'false')

      const frame = document.createElement('div')
      frame.className = 'mindmap-frame'
      const links = document.createElementNS(SVG_NS, 'svg')
      links.classList.add('mindmap-links')
      links.setAttribute('aria-hidden', 'true')
      const treeHost = document.createElement('div')
      treeHost.className = 'mindmap-tree'
      frame.append(links, treeHost)
      dom.append(frame)

      let pendingFocus: string | null = null
      let selectedId: string | null = null
      let editingId: string | null = null
      let linkTask = false
      // True after this view already performed the document undo/redo for the
      // current key. Chrome runs microtasks before beforeinput, so a microtask
      // would clear this too early. A timeout stays set across that beforeinput.
      let historyFromKey = false
      let historyTimer = 0
      let runHistory: HistoryRun = () => {}

      const liveTree = (): MindMapTopic => {
        const pos = readPos(getPos)
        if (pos == null) return normalizeMindMap(node.attrs.tree)
        const current = editor.state.doc.nodeAt(pos)
        if (!current || current.type.name !== 'mindMap') return normalizeMindMap(node.attrs.tree)
        return normalizeMindMap(current.attrs.tree)
      }

      const applyLocale = () => {
        dom.setAttribute('aria-label', t('editor.mindMap.label'))
        for (const input of frame.querySelectorAll<HTMLInputElement>('input.mindmap-topic')) {
          input.placeholder = t('editor.mindMap.topic')
        }
        for (const button of frame.querySelectorAll<HTMLButtonElement>('[data-testid="mindmap-delete"]')) {
          button.setAttribute('aria-label', t('editor.mindMap.delete'))
        }
        for (const input of frame.querySelectorAll<HTMLInputElement>('input.mindmap-topic')) fitTopic(input)
      }

      const drawLinks = () => {
        const width = Math.max(frame.clientWidth, treeHost.scrollWidth)
        const height = Math.max(frame.clientHeight, treeHost.scrollHeight)
        links.setAttribute('width', String(width))
        links.setAttribute('height', String(height))
        links.setAttribute('viewBox', `0 0 ${width} ${height}`)
        while (links.firstChild) links.removeChild(links.firstChild)
        const origin = frame.getBoundingClientRect()
        const scrollX = frame.scrollLeft
        const scrollY = frame.scrollTop
        for (const node of treeHost.querySelectorAll('.mindmap-node')) {
          const children = childByClass(node, 'mindmap-children')
          const fromBox = topicBox(node)
          if (!children || !fromBox) continue
          const from = fromBox.getBoundingClientRect()
          for (const child of children.children) {
            if (!(child instanceof HTMLElement) || !child.classList.contains('mindmap-node')) continue
            const toBox = topicBox(child)
            if (!toBox) continue
            const to = toBox.getBoundingClientRect()
            const x1 = from.right - origin.left + scrollX
            const y1 = from.top + from.height / 2 - origin.top + scrollY
            const x2 = to.left - origin.left + scrollX
            const y2 = to.top + to.height / 2 - origin.top + scrollY
            const bend = Math.max(12, (x2 - x1) * 0.45)
            const path = document.createElementNS(SVG_NS, 'path')
            path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`)
            links.append(path)
          }
        }
      }

      const scheduleLinks = () => {
        if (linkTask) return
        linkTask = true
        const run = () => {
          linkTask = false
          if (!frame.isConnected) return
          for (const input of frame.querySelectorAll<HTMLInputElement>('input.mindmap-topic')) fitTopic(input)
          drawLinks()
        }
        // After the node view is inserted. rAF does not run while the tab is in the background.
        if (typeof queueMicrotask === 'function') queueMicrotask(run)
        else run()
      }

      const renderTopic = (topic: MindMapTopic, isRoot: boolean): HTMLElement => {
        const wrap = document.createElement('div')
        wrap.className = isRoot ? 'mindmap-node is-root' : 'mindmap-node'

        const row = document.createElement('div')
        row.className = 'mindmap-row'

        const pill = document.createElement('span')
        pill.className = 'mindmap-pill'
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'mindmap-topic'
        input.dataset.testid = 'mindmap-topic'
        input.dataset.topicId = topic.id
        input.value = topic.text
        input.spellcheck = false
        input.autocomplete = 'off'
        input.readOnly = true
        pill.append(input)
        row.append(pill)

        if (!isRoot) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'mindmap-delete'
          button.dataset.testid = 'mindmap-delete'
          button.dataset.topicId = topic.id
          button.disabled = !editor.isEditable
          button.append(deleteIcon())
          row.append(button)
        }

        wrap.append(row)
        if (topic.children.length > 0) {
          const children = document.createElement('div')
          children.className = 'mindmap-children'
          for (const child of topic.children) children.append(renderTopic(child, false))
          wrap.append(children)
        }
        return wrap
      }

      const structureMatches = (root: MindMapTopic): boolean => {
        const inputs = frame.querySelectorAll<HTMLInputElement>('input.mindmap-topic')
        const ids = topicIds(root)
        if (inputs.length !== ids.length) return false
        return ids.every((id, index) => inputs[index]?.dataset.topicId === id)
      }

      const syncTexts = (root: MindMapTopic) => {
        const walk = (topic: MindMapTopic) => {
          const input = frame.querySelector<HTMLInputElement>(`input.mindmap-topic${topicSelector(topic.id)}`)
          if (input && input.value !== topic.text) {
            const focused = input.ownerDocument.activeElement === input
            const prev = input.value
            const start = input.selectionStart ?? prev.length
            const end = input.selectionEnd ?? start
            input.value = topic.text
            if (focused) restoreSelection(input, prev, start, end)
          }
          topic.children.forEach(walk)
        }
        walk(root)
      }

      const applyModes = () => {
        const known = new Set(topicIds(liveTree()))
        if (selectedId && !known.has(selectedId)) selectedId = null
        if (editingId && !known.has(editingId)) editingId = null
        const editable = editor.isEditable
        for (const node of frame.querySelectorAll<HTMLElement>('.mindmap-node')) {
          const row = childByClass(node, 'mindmap-row')
          const input = row?.querySelector('input.mindmap-topic')
          if (!(input instanceof HTMLInputElement)) continue
          const id = input.dataset.topicId ?? ''
          const editing = editable && id !== '' && id === editingId
          node.classList.toggle('is-current', id !== '' && id === selectedId)
          node.classList.toggle('is-editing', editing)
          input.readOnly = !editing
        }
      }

      const paint = (root: MindMapTopic) => {
        if (structureMatches(root)) syncTexts(root)
        else treeHost.replaceChildren(renderTopic(root, true))
        const editable = editor.isEditable
        for (const input of frame.querySelectorAll<HTMLInputElement>('input.mindmap-topic')) {
          historyByInput.set(input, runHistory)
        }
        for (const button of frame.querySelectorAll<HTMLButtonElement>('[data-testid="mindmap-delete"]')) {
          button.disabled = !editable
        }
        applyModes()
        applyLocale()
        drawLinks()
        scheduleLinks()
      }

      const focusTopic = (id: string | null) => {
        if (!id) return
        const input = frame.querySelector<HTMLInputElement>(`input.mindmap-topic${topicSelector(id)}`)
        if (!input) return
        input.focus()
        lastTopic = input
        const end = input.value.length
        try {
          input.setSelectionRange(end, end)
        } catch {
          // Detached inputs in jsdom can refuse a selection range.
        }
      }

      const commit = (next: MindMapTopic, focusId: string | null, edit = false) => {
        if (!editor.isEditable || editor.isDestroyed) return
        const pos = readPos(getPos)
        if (pos == null) return
        const current = editor.state.doc.nodeAt(pos)
        if (!current || current.type.name !== 'mindMap') return
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, tree: next })
        if (!tr.docChanged) return
        // Split this commit from the slash insert and from the previous commit,
        // so each tree write is its own undo step. Merging those steps would
        // still restore the earlier tree; it would just undo as one burst.
        if (focusId) {
          selectedId = focusId
          editingId = edit ? focusId : null
        }
        pendingFocus = focusId
        editor.view.dispatch(closeHistory(tr))
      }

      const restoreField = (input: HTMLInputElement, id: string) => {
        const topic = findTopic(liveTree(), id)
        if (!topic || input.value === topic.text) return
        input.value = topic.text
        fitTopic(input)
      }

      const markHistoryKey = () => {
        historyFromKey = true
        if (historyTimer) clearTimeout(historyTimer)
        historyTimer = window.setTimeout(() => {
          historyTimer = 0
          historyFromKey = false
        }, 0)
      }

      runHistory = (kind) => {
        if (!editor.isEditable || editor.isDestroyed) return
        const already = historyFromKey
        markHistoryKey()
        if (already) return
        if (kind === 'redo') editor.commands.redo()
        else editor.commands.undo()
      }

      const onBeforeInput = (event: Event) => {
        if (!(event instanceof InputEvent)) return
        if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return
        const input = event.target
        if (!(input instanceof HTMLInputElement) || !input.classList.contains('mindmap-topic')) return
        // Cancel the field's own undo. Chrome groups typed characters into one
        // native step and then empties that stack, so later menu undos never fire.
        event.preventDefault()
        event.stopPropagation()
        runHistory(event.inputType === 'historyRedo' ? 'redo' : 'undo')
      }

      const onInput = (event: Event) => {
        const input = event.target
        if (!(input instanceof HTMLInputElement) || !input.classList.contains('mindmap-topic')) return
        const id = input.dataset.topicId
        if (!id) return
        if (event instanceof InputEvent && (event.inputType === 'historyUndo' || event.inputType === 'historyRedo')) {
          if (!historyFromKey) runHistory(event.inputType === 'historyRedo' ? 'redo' : 'undo')
          restoreField(input, id)
          scheduleLinks()
          return
        }
        if (editingId !== id) {
          restoreField(input, id)
          return
        }
        fitTopic(input)
        // Pinyin intermediates must not each become an undo step. compositionend commits once.
        if (compositionInput(event)) {
          scheduleLinks()
          return
        }
        commit(renameTopic(liveTree(), id, input.value), null)
        scheduleLinks()
      }

      const onCompositionEnd = (event: Event) => {
        const input = event.target
        if (!(input instanceof HTMLInputElement) || !input.classList.contains('mindmap-topic')) return
        const id = input.dataset.topicId
        if (!id || !editor.isEditable || editingId !== id) return
        fitTopic(input)
        commit(renameTopic(liveTree(), id, input.value), null)
        scheduleLinks()
      }

      const onKeyDown = (event: KeyboardEvent) => {
        const input = event.target
        if (!(input instanceof HTMLInputElement) || !input.classList.contains('mindmap-topic')) return
        const id = input.dataset.topicId
        if (!id || !editor.isEditable) return

        const history = historyCommand(event)
        if (history) {
          // preventDefault here is what stops the input control from also undoing.
          event.preventDefault()
          event.stopPropagation()
          runHistory(history)
          return
        }

        if (event.key === 'Escape') {
          if (editingId !== id) return
          event.preventDefault()
          event.stopPropagation()
          editingId = null
          applyModes()
          input.focus()
          return
        }

        if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault()
          event.stopPropagation()
          const result = addChild(liveTree(), id)
          if (result) commit(result.tree, result.id, true)
          return
        }

        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
          // A composing Enter confirms the candidate. Defer the sibling so a
          // confirm that lands in the IME window never splits the topic.
          event.stopPropagation()
          if (imeBlocksEnterFromEvent(event) || event.isComposing || event.keyCode === 229) return
          event.preventDefault()
          runAfterImeEnter(event, () => {
            if (editor.isDestroyed) return
            const result = addSibling(liveTree(), id)
            if (result) commit(result.tree, result.id, true)
          })
          return
        }

        const emptyDelete = (event.key === 'Backspace' || event.key === 'Delete') && input.value === ''
        if (!emptyDelete || event.isComposing || event.keyCode === 229) return
        const tree = liveTree()
        if (id === tree.id) return
        event.preventDefault()
        event.stopPropagation()
        commit(deleteTopic(tree, id), parentTopicId(tree, id))
      }

      const topicInputFrom = (target: Element): HTMLInputElement | null => {
        const input = target.closest('input.mindmap-topic')
        if (!(input instanceof HTMLInputElement) || !dom.contains(input)) return null
        return input
      }

      const onClick = (event: MouseEvent) => {
        const target = eventElement(event.target)
        if (!target || !dom.contains(target)) return
        const button = target.closest('[data-testid="mindmap-delete"]')
        if (button instanceof HTMLButtonElement && dom.contains(button)) {
          event.preventDefault()
          event.stopPropagation()
          const id = button.dataset.topicId
          if (!id || !editor.isEditable) return
          const tree = liveTree()
          if (id === tree.id) return
          commit(deleteTopic(tree, id), parentTopicId(tree, id))
          return
        }
        const input = topicInputFrom(target)
        if (!input) {
          selectedId = null
          editingId = null
          applyModes()
          return
        }
        const id = input.dataset.topicId
        if (!id) return
        selectedId = id
        if (editingId !== id) editingId = null
        applyModes()
        input.focus()
        lastTopic = input
      }

      const onDblClick = (event: MouseEvent) => {
        if (!editor.isEditable) return
        const target = eventElement(event.target)
        if (!target) return
        const input = topicInputFrom(target)
        if (!input) return
        const id = input.dataset.topicId
        if (!id) return
        event.preventDefault()
        selectedId = id
        editingId = id
        applyModes()
        input.focus()
        lastTopic = input
        const end = input.value.length
        try {
          input.setSelectionRange(0, end)
        } catch {
          // Detached inputs in jsdom can refuse a selection range.
        }
      }

      const onDocumentMouseDown = (event: Event) => {
        const target = event.target
        if (target instanceof Node && dom.contains(target)) return
        if (!selectedId && !editingId) return
        selectedId = null
        editingId = null
        applyModes()
      }

      dom.addEventListener('beforeinput', onBeforeInput)
      dom.addEventListener('input', onInput)
      dom.addEventListener('compositionend', onCompositionEnd)
      dom.addEventListener('keydown', onKeyDown)
      dom.addEventListener('click', onClick)
      dom.addEventListener('dblclick', onDblClick)
      dom.ownerDocument.addEventListener('mousedown', onDocumentMouseDown)
      const unwatch = watchLocale(applyLocale)
      const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => scheduleLinks())
      resize?.observe(treeHost)
      paint(normalizeMindMap(node.attrs.tree))

      return {
        dom,
        update: (updated: ProseMirrorNode) => {
          if (updated.type.name !== 'mindMap') return false
          // Undo can remove the focused field. Keep a topic focused so the next
          // Edit menu command still finds this block; a click into the note does not.
          const owned = lastTopic && historyByInput.get(lastTopic) === runHistory ? lastTopic : null
          paint(normalizeMindMap(updated.attrs.tree))
          const focusId = pendingFocus
          pendingFocus = null
          if (focusId) focusTopic(focusId)
          else if (owned && !owned.isConnected) {
            const active = dom.ownerDocument.activeElement
            const stillHere = active instanceof Element && dom.contains(active)
            const rootInput = frame.querySelector<HTMLInputElement>('input.mindmap-topic')
            if (!stillHere && rootInput?.dataset.topicId) focusTopic(rootInput.dataset.topicId)
          }
          return true
        },
        destroy: () => {
          linkTask = false
          if (historyTimer) clearTimeout(historyTimer)
          historyTimer = 0
          resize?.disconnect()
          unwatch()
          dom.removeEventListener('beforeinput', onBeforeInput)
          dom.removeEventListener('input', onInput)
          dom.removeEventListener('compositionend', onCompositionEnd)
          dom.removeEventListener('keydown', onKeyDown)
          dom.removeEventListener('click', onClick)
          dom.removeEventListener('dblclick', onDblClick)
          dom.ownerDocument.removeEventListener('mousedown', onDocumentMouseDown)
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => {
          const target = eventElement(event.target)
          if (!target) return false
          return Boolean(target.closest('input.mindmap-topic, [data-testid="mindmap-delete"]'))
        },
        selectNode: () => {
          dom.classList.add('is-selected')
        },
        deselectNode: () => {
          dom.classList.remove('is-selected')
        },
      }
    }
  },
})
