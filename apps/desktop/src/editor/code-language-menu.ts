import {
  codeLanguageChoices,
  codeLanguageValue,
  filterCodeLanguageChoices,
  type CodeLanguageChoice,
} from './code-language'

let closeOpenMenu: (() => void) | null = null

/**
 * Searchable language menu fixed to the document, so a scrolling pane does not clip it.
 * One menu is open at a time.
 */
export function attachCodeLanguageMenu(options: {
  trigger: HTMLButtonElement
  getLanguage: () => unknown
  setLanguage: (value: string | null) => void
  isEditable: () => boolean
}): { sync: () => void; destroy: () => void } {
  const { trigger } = options
  const label = document.createElement('span')
  trigger.append(label)
  trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')

  let menu: HTMLDivElement | null = null
  let filter: HTMLInputElement | null = null
  let list: HTMLDivElement | null = null
  let query = ''
  let activeIndex = 0
  let onPointerDown: ((event: PointerEvent) => void) | null = null
  let onScroll: ((event: Event) => void) | null = null
  let onResize: (() => void) | null = null
  let destroyed = false

  const visibleChoices = (): CodeLanguageChoice[] =>
    filterCodeLanguageChoices(codeLanguageChoices(stored()), query)

  const stored = (): string | null => {
    const language = options.getLanguage()
    if (typeof language !== 'string') return null
    const trimmed = language.trim()
    return trimmed === '' ? null : trimmed
  }

  const sync = () => {
    const value = codeLanguageValue(options.getLanguage())
    label.textContent = value === '' ? '自动' : choiceLabel(value)
  }

  const choiceLabel = (value: string): string => {
    for (const choice of codeLanguageChoices(stored())) {
      if (choice.value === value) return choice.label
    }
    return value
  }

  const scrollActive = () => {
    const active = list?.querySelector<HTMLElement>('.is-active')
    if (!active || !list) return
    const top = active.offsetTop
    const bottom = top + active.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }

  const markSelected = () => {
    if (!list || !filter) return
    const selected = codeLanguageValue(options.getLanguage())
    const buttons = list.querySelectorAll<HTMLButtonElement>('button')
    if (buttons.length === 0) {
      filter.removeAttribute('aria-activedescendant')
      return
    }
    if (activeIndex >= buttons.length) activeIndex = buttons.length - 1
    buttons.forEach((option, index) => {
      const on = option.getAttribute('data-value') === selected
      option.classList.toggle('is-on', on)
      option.classList.toggle('is-active', index === activeIndex)
      option.setAttribute('aria-selected', on ? 'true' : 'false')
      if (index === activeIndex) option.id = 'editor-code-lang-active'
      else option.removeAttribute('id')
    })
    filter.setAttribute('aria-activedescendant', 'editor-code-lang-active')
  }

  const renderList = (scroll: boolean) => {
    if (!list || !filter) return
    const items = visibleChoices()
    list.replaceChildren()
    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'editor-code-menu-empty'
      empty.textContent = '没有匹配的语言'
      list.append(empty)
      filter.removeAttribute('aria-activedescendant')
      return
    }
    if (activeIndex >= items.length) activeIndex = items.length - 1
    items.forEach((item, index) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = 'editor-code-menu-option'
      option.setAttribute('role', 'option')
      option.setAttribute('data-value', item.value)
      option.textContent = item.label
      option.addEventListener('pointermove', () => {
        if (activeIndex === index) return
        activeIndex = index
        markSelected()
      })
      option.addEventListener('click', () => commit(item.value))
      list?.append(option)
    })
    markSelected()
    if (scroll) scrollActive()
  }

  const closeMenu = (focusTrigger: boolean) => {
    if (!menu) {
      if (focusTrigger) trigger.focus()
      return
    }
    menu.remove()
    menu = null
    filter = null
    list = null
    query = ''
    trigger.classList.remove('is-open')
    trigger.setAttribute('aria-expanded', 'false')
    if (onPointerDown) document.removeEventListener('pointerdown', onPointerDown, true)
    if (onScroll) document.removeEventListener('scroll', onScroll, true)
    if (onResize) window.removeEventListener('resize', onResize)
    onPointerDown = null
    onScroll = null
    onResize = null
    if (closeOpenMenu === closeFromOutside) closeOpenMenu = null
    if (focusTrigger && !destroyed) trigger.focus()
  }

  const closeFromOutside = () => closeMenu(false)

  const place = () => {
    if (!menu) return
    if (!trigger.isConnected) {
      closeMenu(false)
      return
    }
    const rect = trigger.getBoundingClientRect()
    const margin = 8
    if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
      closeMenu(false)
      return
    }
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    let left = rect.right - width
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
    const gap = 4
    let top = rect.bottom + gap
    if (top + height > window.innerHeight - margin && rect.top - gap - height >= margin) {
      top = rect.top - gap - height
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }

  const commit = (value: string) => {
    closeMenu(false)
    const next = value === '' ? null : value
    const current = stored()
    const same = current === next || (next !== null && codeLanguageValue(current) === next)
    if (!same) options.setLanguage(next)
    sync()
  }

  const openMenu = () => {
    if (menu || !options.isEditable()) return
    closeOpenMenu?.()
    query = ''
    const items = codeLanguageChoices(stored())
    const selected = codeLanguageValue(options.getLanguage())
    const selectedIndex = items.findIndex((item) => item.value === selected)
    activeIndex = selectedIndex >= 0 ? selectedIndex : 0

    const popup = document.createElement('div')
    const field = document.createElement('input')
    const optionsBox = document.createElement('div')
    menu = popup
    filter = field
    list = optionsBox

    popup.className = 'editor-code-menu'
    popup.setAttribute('role', 'dialog')
    popup.setAttribute('aria-label', '代码语言')
    field.type = 'text'
    field.className = 'editor-code-menu-filter'
    field.placeholder = '筛选语言'
    field.autocomplete = 'off'
    field.spellcheck = false
    field.setAttribute('aria-label', '筛选语言')
    field.setAttribute('aria-autocomplete', 'list')
    field.setAttribute('aria-controls', 'editor-code-lang-list')
    optionsBox.id = 'editor-code-lang-list'
    optionsBox.className = 'editor-code-menu-list'
    optionsBox.setAttribute('role', 'listbox')
    optionsBox.setAttribute('aria-label', '代码语言')
    popup.append(field, optionsBox)
    popup.style.visibility = 'hidden'
    popup.addEventListener('mousedown', (event) => {
      if (event.target === field) return
      event.preventDefault()
    })
    document.body.append(popup)
    renderList(true)
    place()
    if (!menu) return
    popup.style.visibility = 'visible'
    trigger.classList.add('is-open')
    trigger.setAttribute('aria-expanded', 'true')
    closeOpenMenu = closeFromOutside
    field.focus()

    field.addEventListener('input', () => {
      query = field.value
      const now = visibleChoices()
      const selectedNow = codeLanguageValue(options.getLanguage())
      const keep = now.findIndex((item) => item.value === selectedNow)
      activeIndex = keep >= 0 ? keep : 0
      renderList(true)
    })
    let composing = false
    let compositionEndedAt = 0
    field.addEventListener('compositionstart', () => {
      composing = true
    })
    field.addEventListener('compositionend', (event) => {
      composing = false
      compositionEndedAt = event.timeStamp
    })
    field.addEventListener('keydown', (event) => {
      const imeEnter =
        event.key === 'Enter' &&
        (event.isComposing ||
          event.keyCode === 229 ||
          composing ||
          (compositionEndedAt !== 0 && Math.abs(event.timeStamp - compositionEndedAt) < 50))
      if (event.isComposing || event.keyCode === 229 || imeEnter) return
      const now = visibleChoices()
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (now.length === 0) return
        activeIndex = (activeIndex + 1) % now.length
        markSelected()
        scrollActive()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (now.length === 0) return
        activeIndex = (activeIndex - 1 + now.length) % now.length
        markSelected()
        scrollActive()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const stamp = event.timeStamp
        const choices = now
        const index = activeIndex
        setTimeout(() => {
          if (composing) return
          if (compositionEndedAt !== 0 && Math.abs(stamp - compositionEndedAt) < 50) return
          const item = choices[index]
          if (item) commit(item.value)
        }, 0)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeMenu(true)
      } else if (event.key === 'Tab') {
        closeMenu(true)
      }
    })

    onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popup.contains(target) || trigger.contains(target)) return
      closeMenu(false)
    }
    onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && popup.contains(target)) return
      place()
    }
    onResize = () => place()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
  }

  trigger.addEventListener('mousedown', (event) => {
    event.preventDefault()
  })
  trigger.addEventListener('click', () => {
    if (menu) closeMenu(true)
    else openMenu()
  })

  sync()
  return {
    sync,
    destroy: () => {
      destroyed = true
      closeMenu(false)
    },
  }
}
