declare global {
  interface Window {
    __strideLastError?: string
    __strideConsole?: string[]
  }
}

const refs = new Map<string, Element>()

const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), textarea, select, [contenteditable="true"]'

export async function runPageCommand(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (action) {
    case 'snapshot':
      return snapshot()
    case 'click':
      return click(requiredSelector(action, args))
    case 'fill':
      return fill(requiredSelector(action, args), requiredValue(args))
    case 'evaluate':
      return evaluate(requiredCode(args))
    case 'wait':
      return waitFor(args)
    default:
      throw new Error(`unknown tool: ${action}`)
  }
}

function snapshot() {
  refs.clear()
  const lines: string[] = []
  let index = 0
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!(el instanceof HTMLElement) || !visible(el)) continue
    index += 1
    const ref = `@e${index}`
    refs.set(ref, el)
    el.setAttribute('data-stride-ref', ref)
    const role = roleOf(el)
    const name = accessibleName(el).replace(/"/g, '\\"')
    const value = currentValue(el)
    const valueBit = value ? ` [value="${value.replace(/"/g, '\\"').slice(0, 80)}"]` : ''
    lines.push(`- ${role} "${name}"${valueBit} [ref=${ref}]`)
  }
  const pageError = window.__strideLastError
  const consoleError = window.__strideConsole?.at(-1)
  return {
    url: location.href,
    title: document.title,
    tree: lines.length ? `${lines.join('\n')}\n` : '',
    count: index,
    ...(pageError ? { error: pageError } : {}),
    ...(consoleError ? { console: consoleError } : {}),
  }
}

function click(selector: string) {
  const el = resolve(selector, 'click')
  el.scrollIntoView?.({ block: 'center' })
  if (el instanceof HTMLElement) el.focus()
  if (el instanceof HTMLElement) el.click()
  return { clicked: selector, name: accessibleName(el) }
}

function fill(selector: string, value: string) {
  const el = resolve(selector, 'fill')
  if (!(el instanceof HTMLElement)) throw new Error('fill: target is not an element')
  el.focus()
  if (isEditor(el)) {
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(el)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    let inserted = false
    try {
      inserted = document.execCommand?.('insertText', false, value) ?? false
    } catch {
      inserted = false
    }
    if (!inserted) {
      el.textContent = value
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    }
    return { mode: 'contenteditable', selector }
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, value)
    return { mode: 'value', selector }
  }
  throw new Error('fill: target is not an input or editor')
}

function evaluate(code: string) {
  const body = /\breturn\b/.test(code) ? code : `return (${code})`
  const value: unknown = new Function(body)()
  return { value }
}

async function waitFor(args: Record<string, unknown>) {
  const timeout = Number(args.timeout_ms ?? 5000)
  const text = typeof args.text === 'string' ? args.text : ''
  const selector = typeof args.selector === 'string' ? args.selector : ''
  if (!text && !selector) throw new Error('wait: text or selector is required')
  const started = Date.now()
  while (Date.now() - started <= timeout) {
    if (selector && find(selector)) return { found: true }
    if (text && (document.body.textContent || '').includes(text)) return { found: true }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`wait: timed out after ${timeout}ms`)
}

function resolve(selector: string, tool: string): Element {
  const found = find(selector)
  if (found) return found
  if (selector.startsWith('@e')) {
    throw new Error(`${tool}: unknown ref "${selector}". Run snapshot first.`)
  }
  throw new Error(`${tool}: selector not found: ${selector}`)
}

function find(selector: string): Element | null {
  if (selector.startsWith('@e')) return refs.get(selector) ?? null
  return document.querySelector(selector)
}

function requiredSelector(tool: string, args: Record<string, unknown>): string {
  const selector = args.selector
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error(`${tool}: selector is required (CSS selector or @e ref)`)
  }
  return selector
}

function requiredValue(args: Record<string, unknown>): string {
  if (typeof args.value !== 'string') throw new Error('fill: value is required')
  return args.value
}

function requiredCode(args: Record<string, unknown>): string {
  if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('evaluate: code is required')
  return args.code
}

function visible(el: HTMLElement): boolean {
  if (el.getAttribute('hidden') != null || el.getAttribute('aria-hidden') === 'true') return false
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function roleOf(el: Element): string {
  const role = el.getAttribute('role')
  if (role) return role
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLTextAreaElement) return 'textbox'
  if (el instanceof HTMLInputElement) return el.type === 'password' ? 'password' : 'textbox'
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLSelectElement) return 'combobox'
  if (isEditor(el)) return 'textbox'
  return el.tagName.toLowerCase()
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria?.trim()) return aria.trim()
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const label = el.closest('label')?.querySelector('span')?.textContent?.trim()
    if (label) return label
    if (el.placeholder) return el.placeholder
    if (el.classList.contains('note-title')) return 'Title'
  }
  return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

function currentValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
  if (isEditor(el)) return (el.textContent || '').trim()
  return ''
}

function isEditor(el: Element): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('contenteditable') === 'true')
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  const tracked = el as HTMLInputElement & { _valueTracker?: { setValue: (next: string) => void } }
  tracked._valueTracker?.setValue(el.value)
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
