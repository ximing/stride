import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Combobox, type ComboboxOption } from './combobox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS: ComboboxOption[] = [
  { value: 'draft', label: 'Draft', dot: 'var(--sd-warning)' },
  { value: 'doing', label: 'Doing' },
  { value: 'done', label: 'Done' },
]

let root: Root | null = null
let host: HTMLDivElement | null = null

const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView

async function mount(children: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(children)
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
}

function setControlValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function keydown(element: HTMLElement, key: string) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** Radix popover triggers toggle on pointerdown, which element.click() skips. */
async function openTrigger(testId: string) {
  const trigger = host!.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    trigger.click()
  })
}

function options(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
}

function SingleHarness({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState('draft')
  return (
    <Combobox
      data-testid="combo"
      value={value}
      options={OPTIONS}
      allowCreate
      createLabel={(query) => `Create "${query}"`}
      emptyLabel="No matches"
      searchPlaceholder="Search…"
      onValueChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

function MultiHarness({
  onPick,
  onRemoveLast,
}: {
  onPick: (value: string) => void
  onRemoveLast: () => void
}) {
  const [values, setValues] = useState<string[]>(['alpha'])
  return (
    <Combobox
      multiple
      data-testid="combo-multi"
      values={values}
      options={[{ value: 'alpha' }, { value: 'beta' }, { value: 'gamma' }]}
      allowCreate
      createLabel={(query) => `Create "${query}"`}
      emptyLabel="No matches"
      placeholder="Add…"
      onPick={(next) => {
        setValues((current) => [...current, next])
        onPick(next)
      }}
      onRemoveLast={onRemoveLast}
    />
  )
}

describe('Combobox', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  afterEach(async () => {
    await unmount()
    if (originalScrollIntoView) window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    else Reflect.deleteProperty(window.HTMLElement.prototype, 'scrollIntoView')
  })

  it('shows the current value on the trigger and selects an option', async () => {
    const picked: string[] = []
    await mount(<SingleHarness onChange={(value) => picked.push(value)} />)
    const trigger = host!.querySelector<HTMLButtonElement>('[data-testid="combo"]')!
    expect(trigger.textContent).toContain('Draft')
    expect(trigger.querySelector('.sd-combobox-dot')).not.toBeNull()

    await openTrigger('combo')
    const listbox = document.querySelector('[role="listbox"]')
    expect(listbox).not.toBeNull()
    expect(options().map((option) => option.textContent)).toEqual(['Draft', 'Doing', 'Done'])
    expect(options()[0].getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      options()[2].click()
    })
    expect(picked).toEqual(['done'])
    expect(trigger.textContent).toContain('Done')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('filters options by the search input and creates new values', async () => {
    const picked: string[] = []
    await mount(<SingleHarness onChange={(value) => picked.push(value)} />)
    await openTrigger('combo')
    const search = document.querySelector<HTMLInputElement>('.sd-combobox-search')!
    expect(document.activeElement).toBe(search)

    await act(async () => {
      setControlValue(search, 'do')
    })
    // "do" matches no option exactly, so a create row trails the matches.
    expect(options().map((option) => option.textContent)).toEqual(['Doing', 'Done', 'Create "do"'])

    await act(async () => {
      setControlValue(search, 'blocked')
    })
    const rows = options()
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toBe('Create "blocked"')
    expect(rows[0].dataset.testid).toBe('combo-create')

    await act(async () => {
      rows[0].click()
    })
    expect(picked).toEqual(['blocked'])
  })

  it('navigates with arrow keys, Enter and Escape', async () => {
    const picked: string[] = []
    await mount(<SingleHarness onChange={(value) => picked.push(value)} />)
    await openTrigger('combo')
    const search = document.querySelector<HTMLInputElement>('.sd-combobox-search')!
    // Active row starts on the current value (index 0); move down and pick.
    await act(async () => {
      keydown(search, 'ArrowDown')
    })
    expect(options()[1].className).toContain('is-active')
    await act(async () => {
      keydown(search, 'ArrowUp')
    })
    expect(options()[0].className).toContain('is-active')
    await act(async () => {
      keydown(search, 'ArrowDown')
    })
    expect(options()[1].className).toContain('is-active')
    await act(async () => {
      keydown(search, 'Enter')
    })
    expect(picked).toEqual(['doing'])

    await openTrigger('combo')
    await act(async () => {
      keydown(document.querySelector<HTMLInputElement>('.sd-combobox-search')!, 'Escape')
    })
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('suppresses the create row when the query exactly matches an option', async () => {
    await mount(<SingleHarness onChange={() => {}} />)
    await openTrigger('combo')
    const search = document.querySelector<HTMLInputElement>('.sd-combobox-search')!
    await act(async () => {
      setControlValue(search, 'Doing')
    })
    expect(options().map((option) => option.textContent)).toEqual(['Doing'])
    expect(document.querySelector('[data-testid="combo-create"]')).toBeNull()
  })

  it('picks and creates values in multiple mode, excluding picked ones', async () => {
    const picked: string[] = []
    await mount(<MultiHarness onPick={(value) => picked.push(value)} onRemoveLast={() => {}} />)
    const input = host!.querySelector<HTMLInputElement>('[data-testid="combo-multi"]')!
    await act(async () => {
      input.focus()
    })
    // alpha is already picked, so only beta and gamma remain.
    expect(options().map((option) => option.textContent)).toEqual(['beta', 'gamma'])

    await act(async () => {
      options()[0].click()
    })
    expect(picked).toEqual(['beta'])
    expect(input.value).toBe('')
    expect(options().map((option) => option.textContent)).toEqual(['gamma'])

    await act(async () => {
      setControlValue(input, 'delta')
    })
    await act(async () => {
      keydown(input, 'Enter')
    })
    expect(picked).toEqual(['beta', 'delta'])
  })

  it('removes the last value on Backspace with an empty input', async () => {
    let removed = 0
    await mount(<MultiHarness onPick={() => {}} onRemoveLast={() => removed++} />)
    const input = host!.querySelector<HTMLInputElement>('[data-testid="combo-multi"]')!
    await act(async () => {
      keydown(input, 'Backspace')
    })
    expect(removed).toBe(1)
    await act(async () => {
      setControlValue(input, 'b')
      keydown(input, 'Backspace')
    })
    expect(removed).toBe(1)
  })
})
