import { register, resolve } from '@rabjs/react'
import type { StrideNote } from '@stride/core/note'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notePath, readNoteFile } from '../../../../../packages/core/src/vault'
import { App } from '../../app'
import { FolderService } from '../../services/vault/folder.service'
import { ChatService } from '../../services/chat/chat.service'
import { GitService } from '../../services/git/git.service'
import { SettingsService } from '../../services/settings/settings.service'
import { UpdateService } from '../../services/update/update.service'
import { VaultService } from '../../services/vault/vault.service'
import { PropertiesPanel } from './properties-panel'

const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView

function linkedNote(id: string, title: string, properties: StrideNote['properties'], targets: string[]): StrideNote {
  return {
    id,
    title,
    type: 'note',
    properties,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: targets.map((target) => ({ type: 'wikilink', attrs: { target } })),
        },
      ],
    },
  }
}

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function setControlValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

async function selectPropertyType(host: HTMLElement, label: string) {
  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="property-type"]')!
  await act(async () => {
    trigger.click()
  })
  const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === label)
  expect(option, `Missing ${label} option`).not.toBeNull()
  await act(async () => {
    ;(option as HTMLElement).click()
  })
}

async function openAddPropertyForm(host: HTMLElement) {
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="add-property-open"]')
  if (!toggle) return
  await act(async () => {
    toggle.click()
  })
}

/** Radix dropdown triggers toggle on pointerdown, which element.click() skips. */
async function openRowMenu(host: HTMLElement, name: string) {
  const trigger = host.querySelector<HTMLButtonElement>(
    `[data-testid="property-field"][data-name="${name}"] [data-testid="property-actions"]`,
  )!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    trigger.click()
  })
}

/** Note-level actions sit inline in the panel head — no ⋯ menu to open. */
async function clickNoteAction(testId: string) {
  await act(async () => {
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click()
  })
}

/** Radix popover triggers toggle on pointerdown, which element.click() skips. */
async function openCombobox(host: HTMLElement, testId: string) {
  const trigger = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    trigger.click()
  })
}

function comboboxOptions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
}

/** The relation form is collapsed behind an "Add relationship" button. */
async function openRelationForm(host: HTMLElement) {
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="add-relation-open"]')!.click()
  })
}

/** Opens a Radix popover trigger the way a real pointer would: pointerdown
 * focuses the trigger first, otherwise Radix sees focus-in on the trigger
 * *after* the popover mounts and dismisses it as "focus outside". */
async function openPopoverTrigger(trigger: HTMLButtonElement) {
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
  })
  await act(async () => {
    trigger.click()
  })
}

describe('PropertiesPanel', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    window.history.replaceState(null, '', '/')
    if (originalScrollIntoView) window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    else Reflect.deleteProperty(window.HTMLElement.prototype, 'scrollIntoView')
  })

  it('writes a number and a boolean as JSON and does not render _secret', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const id = vault.active?.id ?? ''
    vault.updateProperty('_secret', 'classified-marker')
    vault.updateProperty('template', 'daily')
    vault.updateProperty('visible', 'true')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      expect(host.querySelector('[data-testid="property-field"][data-name="_secret"]')).toBeNull()
      expect(host.textContent).not.toContain('_secret')
      expect(host.textContent).not.toContain('classified-marker')
      expect(host.querySelector('[data-testid="property-field"][data-name="template"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="property-field"][data-name="visible"]')).not.toBeNull()
      expect(host.querySelector('[data-name="_icon"]')).toBeNull()

      await openAddPropertyForm(host)
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'count')
      })
      await selectPropertyType(host, 'number')
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-value"]')!, '12')
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')!.click()
      })

      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'done')
      })
      await selectPropertyType(host, 'boolean')
      const checkbox = host.querySelector<HTMLInputElement>('[data-testid="property-value"]')!
      expect(checkbox.type).toBe('checkbox')
      await act(async () => {
        checkbox.click()
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')!.click()
      })

      expect(host.querySelector('[data-testid="property-field"][data-name="count"] input')).toHaveProperty('type', 'number')
      expect(host.querySelector<HTMLInputElement>('[data-testid="property-field"][data-name="done"] input')?.checked).toBe(true)
      expect(host.querySelector('[data-name="_secret"]')).toBeNull()

      await act(async () => {
        host.querySelector<HTMLInputElement>('[data-name="count"] input')!.blur()
        await vault.flush()
      })

      const raw = JSON.parse(await vault.fs!.readText(`${id}.stride.json`)) as { properties: Record<string, unknown> }
      expect(raw.properties.count).toBe(12)
      expect(typeof raw.properties.count).toBe('number')
      expect(raw.properties.done).toBe(true)
      expect(typeof raw.properties.done).toBe('boolean')
      expect(raw.properties._secret).toBe('classified-marker')

      const saved = await readNoteFile(vault.fs!, `${id}.stride.json`, id)
      expect(saved.properties.count).toBe(12)
      expect(saved.properties.done).toBe(true)

      await act(async () => {
        host.querySelector<HTMLInputElement>('[data-name="done"] input')!.click()
        await vault.flush()
      })
      const unchecked = JSON.parse(await vault.fs!.readText(`${id}.stride.json`)) as { properties: Record<string, unknown> }
      expect(unchecked.properties.done).toBe(false)
      expect(typeof unchecked.properties.done).toBe('boolean')
      expect(host.querySelector('[data-testid="property-field"][data-name="done"]')).not.toBeNull()
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('keeps a single plain token as a string unless the type is list', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const id = vault.active?.id ?? ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      await openAddPropertyForm(host)
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'label')
      })
      await selectPropertyType(host, 'string')
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-value"]')!, 'solo')
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')!.click()
      })
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'tags')
      })
      await selectPropertyType(host, 'list')
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-value"]')!, 'solo')
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')!.click()
      })
      await act(async () => {
        await vault.flush()
      })
      const raw = JSON.parse(await vault.fs!.readText(`${id}.stride.json`)) as { properties: Record<string, unknown> }
      expect(raw.properties.label).toBe('solo')
      expect(raw.properties.tags).toEqual(['solo'])
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('navigates body links and property backlinks between two notes', async () => {
    register(VaultService)
    const vault = resolve(VaultService)
    vault.fs = null
    vault.notes = [
      linkedNote('note-a', 'Note A', {}, ['Note B']),
      linkedNote('note-b', 'Note B', { related_to: '[[Note A]]' }, []),
    ]
    vault.activeId = 'note-a'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      const toB = host.querySelector<HTMLButtonElement>('[data-testid="relation-link"][data-target="note-b"]')
      const backToB = host.querySelector<HTMLButtonElement>('[data-testid="backlink"][data-source="note-b"]')
      expect(toB).not.toBeNull()
      expect(toB?.textContent).toContain('Note B')
      // body links carry no kind tag
      expect(toB?.querySelector('.relation-kind')).toBeNull()
      expect(backToB).not.toBeNull()
      await act(async () => {
        toB!.click()
      })
      expect(vault.activeId).toBe('note-b')

      const toA = host.querySelector<HTMLButtonElement>('[data-testid="relation-link"][data-target="note-a"]')
      const backToA = host.querySelector<HTMLButtonElement>('[data-testid="backlink"][data-source="note-a"]')
      expect(toA).not.toBeNull()
      // structural relations show their kind as an inline tag
      expect(toA?.querySelector('.relation-kind')?.textContent).toBe('Related to')
      expect(backToA).not.toBeNull()
      await act(async () => {
        backToA!.click()
      })
      expect(vault.activeId).toBe('note-a')

      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="backlink"][data-source="note-b"]')!.click()
      })
      expect(vault.activeId).toBe('note-b')
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="relation-link"][data-target="note-a"]')!.click()
      })
      expect(vault.activeId).toBe('note-a')
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('links belongs_to and related_to by picking a note', async () => {
    register(VaultService)
    const vault = resolve(VaultService)
    vault.fs = null
    vault.notes = [
      linkedNote('note-a', 'Note A', {}, []),
      linkedNote('note-b', 'Note B', {}, []),
    ]
    vault.activeId = 'note-a'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      await openRelationForm(host)
      // the target picker lists every note up front and filters as you type
      await openPopoverTrigger(host.querySelector<HTMLButtonElement>('[data-testid="relation-target"]')!)
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-testid="relation-match"]').length).toBeGreaterThan(0)
      })
      await act(async () => {
        setControlValue(document.querySelector<HTMLInputElement>('.sd-combobox-search')!, 'note b')
      })
      await act(async () => {
        ;[...document.querySelectorAll<HTMLElement>('[data-testid="relation-match"]')]
          .find((option) => option.textContent === 'Note B')!
          .click()
      })
      expect(vault.notes.find((note) => note.id === 'note-a')?.properties.belongs_to).toEqual(['[[Note B]]'])
      expect(host.querySelector('[data-testid="property-field"][data-name="belongs_to"]')).toBeNull()
      expect(host.textContent).toContain('Belongs to')
      expect(vault.notes.find((note) => note.id === 'note-b')?.properties.has).toBeUndefined()

      // the form collapses after each add; reopen it for the next kind
      await openRelationForm(host)
      const kind = host.querySelector<HTMLButtonElement>('[data-testid="relation-kind"]')!
      await act(async () => {
        kind.click()
      })
      const related = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === 'Related to')
      expect(related).not.toBeNull()
      await act(async () => {
        ;(related as HTMLElement).click()
      })
      await openPopoverTrigger(host.querySelector<HTMLButtonElement>('[data-testid="relation-target"]')!)
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-testid="relation-match"]').length).toBeGreaterThan(0)
      })
      await act(async () => {
        setControlValue(document.querySelector<HTMLInputElement>('.sd-combobox-search')!, 'note b')
      })
      await act(async () => {
        ;[...document.querySelectorAll<HTMLElement>('[data-testid="relation-match"]')]
          .find((option) => option.textContent === 'Note B')!
          .click()
      })
      expect(vault.notes.find((note) => note.id === 'note-a')?.properties.related_to).toEqual(['[[Note B]]'])

      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="relation-remove"][data-field="belongs_to"]')!.click()
      })
      expect(vault.notes.find((note) => note.id === 'note-a')?.properties.belongs_to).toBeUndefined()
      expect(vault.notes.find((note) => note.id === 'note-a')?.properties.related_to).toEqual(['[[Note B]]'])
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('shows unresolved wikilinks as text and does not select an empty id', async () => {
    register(VaultService)
    const vault = resolve(VaultService)
    vault.fs = null
    vault.notes = [linkedNote('note-a', 'Note A', { related_to: '[[Missing person]]' }, ['Ghost'])]
    vault.activeId = 'note-a'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      expect(host.textContent).toContain('Missing person')
      expect(host.textContent).toContain('Ghost')
      expect(host.querySelector('[data-testid="relation-link"]')).toBeNull()
      expect(host.querySelector('[data-target=""]')).toBeNull()
      expect(vault.activeId).toBe('note-a')
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('archives the active note out of the list and deletes it after confirmation', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    register(GitService)
    register(SettingsService)
    register(ChatService)
    register(UpdateService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const keptId = vault.active?.id ?? ''
    vault.updateTitle('Kept note')
    await vault.createNote()
    const id = vault.active?.id ?? ''
    vault.updateTitle('Archived note')
    vault.renameFromHeading = false
    vault.cancelPending()

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<App />)
      })
      const linkText = () => [...host.querySelectorAll('[data-testid="note-link"]')].map((node) => node.textContent ?? '')
      expect(linkText()).toContain('Archived note')
      expect(host.querySelector<HTMLInputElement>('[data-testid="note-title"]')?.value).toBe('Archived note')

      await clickNoteAction('archive-note')
      expect(linkText()).not.toContain('Archived note')
      expect(linkText()).toContain('Kept note')
      expect(host.querySelector<HTMLInputElement>('[data-testid="note-title"]')?.value).toBe('Archived note')
      vault.cancelPending()

      await clickNoteAction('delete-note')
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="cancel-delete"]')!.click()
      })
      expect(await vault.fs!.stat(notePath(id))).not.toBeNull()
      expect(await vault.fs!.stat(notePath(keptId))).not.toBeNull()

      await clickNoteAction('delete-note')
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete"]')!.click()
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
      })
      expect(await vault.fs!.stat(notePath(id))).toBeNull()
      expect(vault.notes.some((note) => note.id === id)).toBe(false)
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('renames a property inline and rejects duplicate names', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateProperty('status', 'open')
    vault.updateProperty('owner', 'me')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const pressEnter = (element: HTMLElement) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    }
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      const row = () => host.querySelector('[data-testid="property-field"][data-name="status"]')!
      await act(async () => {
        row().querySelector<HTMLButtonElement>('[data-testid="property-rename-open"]')!.click()
      })
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-rename"]')!, 'state')
      })
      await act(async () => {
        pressEnter(host.querySelector<HTMLElement>('[data-testid="property-rename"]')!)
      })
      expect(vault.active?.properties.state).toBe('open')
      expect(vault.active?.properties.status).toBeUndefined()
      expect(vault.active?.properties.owner).toBe('me')

      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="property-field"][data-name="state"] [data-testid="property-rename-open"]')!.click()
      })
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-rename"]')!, 'owner')
      })
      await act(async () => {
        pressEnter(host.querySelector<HTMLElement>('[data-testid="property-rename"]')!)
      })
      expect(vault.active?.properties.state).toBe('open')
      expect(vault.active?.properties.owner).toBe('me')
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('converts a property kind from the row menu and refuses invalid numbers', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateProperty('count', '12')
    vault.updateProperty('label', 'abc')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      await openRowMenu(host, 'count')
      await act(async () => {
        document.querySelector<HTMLElement>('[data-testid="convert-to-number"]')!.click()
      })
      expect(vault.active?.properties.count).toBe(12)

      await openRowMenu(host, 'label')
      await act(async () => {
        document.querySelector<HTMLElement>('[data-testid="convert-to-number"]')!.click()
      })
      expect(vault.active?.properties.label).toBe('abc')
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('edits a list property as chips', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateListProperty('tags', 'alpha beta')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const row = () => host.querySelector('[data-testid="property-field"][data-name="tags"]')
    const input = () => row()?.querySelector<HTMLInputElement>('[data-testid="list-item-input"]')
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      expect(row()?.querySelectorAll('[data-testid="list-item"]')).toHaveLength(2)

      await act(async () => {
        setControlValue(input()!, 'gamma')
      })
      await act(async () => {
        input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(vault.active?.properties.tags).toEqual(['alpha', 'beta', 'gamma'])

      await act(async () => {
        row()!.querySelector<HTMLButtonElement>('[data-testid="list-item-remove"][data-index="0"]')!.click()
      })
      expect(vault.active?.properties.tags).toEqual(['beta', 'gamma'])

      await act(async () => {
        input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
      })
      expect(vault.active?.properties.tags).toEqual(['beta'])

      await act(async () => {
        row()!.querySelector<HTMLButtonElement>('[data-testid="list-item-remove"][data-index="0"]')!.click()
      })
      expect(vault.active?.properties.tags).toBeUndefined()
      expect(row()).toBeNull()
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('types status, date, tags and the type row with searchable controls', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateProperty('status', 'draft')
    vault.updateProperty('date', '2026-10-24')
    vault.updateListProperty('tags', 'alpha')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })

      // status: preset labels on the trigger, tinted by tone
      const statusTrigger = host.querySelector<HTMLButtonElement>('[data-testid="status-combobox"]')!
      expect(statusTrigger.textContent).toContain('Draft')
      expect(statusTrigger.className).toContain('is-draft')
      await openCombobox(host, 'status-combobox')
      const done = comboboxOptions().find((option) => option.textContent === 'Done')!
      await act(async () => {
        done.click()
      })
      expect(vault.active?.properties.status).toBe('done')
      expect(statusTrigger.className).toContain('is-done')

      // date: the custom picker's trigger shows the stored day, and picking a
      // day from the calendar rewrites it
      const dateTrigger = host.querySelector<HTMLButtonElement>('[data-testid="date-input"]')!
      expect(dateTrigger.textContent).toContain('2026')
      await openPopoverTrigger(dateTrigger)
      // The popover portal mounts a beat after the trigger fires.
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="date-input-day"][data-date="2026-10-15"]')).not.toBeNull()
      })
      await act(async () => {
        document.querySelector<HTMLElement>('[data-testid="date-input-day"][data-date="2026-10-15"]')!.click()
      })
      expect(vault.active?.properties.date).toBe('2026-10-15')
      // Today lives in the calendar footer now
      await openPopoverTrigger(dateTrigger)
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="date-input-today"]')).not.toBeNull()
      })
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="date-input-today"]')!.click()
      })
      const now = new Date()
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      expect(vault.active?.properties.date).toBe(today)

      // tags: vault candidates plus free creation through the combobox input
      const tagInput = host.querySelector<HTMLInputElement>(
        '[data-testid="property-field"][data-name="tags"] [data-testid="list-item-input"]',
      )!
      await act(async () => {
        tagInput.focus()
      })
      // alpha is already picked, so it is excluded from the candidates.
      expect(comboboxOptions().map((option) => option.textContent)).toEqual([])
      await act(async () => {
        setControlValue(tagInput, 'beta')
      })
      await act(async () => {
        tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(vault.active?.properties.tags).toEqual(['alpha', 'beta'])

      // type row: combobox can create a new type name
      const typeTrigger = host.querySelector<HTMLButtonElement>('[data-testid="type-combobox"]')!
      expect(typeTrigger.textContent).toContain('note')
      await openCombobox(host, 'type-combobox')
      const search = document.querySelector<HTMLInputElement>('.sd-combobox-search')!
      await act(async () => {
        setControlValue(search, 'Project')
      })
      await act(async () => {
        document.querySelector<HTMLElement>('[data-testid="type-combobox-create"]')!.click()
      })
      expect(vault.active?.type).toBe('Project')
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('creates a note from an unresolved relation link', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const sourceId = vault.active?.id ?? ''
    vault.updateTitle('Source')
    vault.updateProperty('related_to', '[[Ghost]]')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      const create = host.querySelector<HTMLButtonElement>('[data-testid="relation-create"][data-field="related_to"]')
      expect(create).not.toBeNull()
      await act(async () => {
        create!.click()
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
      })
      const ghost = vault.notes.find((note) => note.title === 'Ghost')
      expect(ghost).toBeDefined()
      expect(vault.activeId).toBe(ghost?.id ?? '')
      expect(vault.activeId).not.toBe(sourceId)
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('flags duplicate property names in the add form', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateProperty('template', 'daily')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      await openAddPropertyForm(host)
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'template')
      })
      expect(host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')?.disabled).toBe(true)
      expect(host.textContent).toContain('already exists')

      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'fresh')
      })
      expect(host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')?.disabled).toBe(false)
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('adds a date property through the calendar picker', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      await openAddPropertyForm(host)
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'deadline')
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="property-type"]')!.click()
      })
      const dateOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent === 'date',
      )!
      await act(async () => {
        dateOption.click()
      })
      // the date type swaps the free-text value for the calendar picker and
      // requires a picked day before submitting
      expect(host.querySelector('input[data-testid="property-value"]')).toBeNull()
      expect(host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')?.disabled).toBe(true)

      const now = new Date()
      const picked = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-15`
      await openPopoverTrigger(host.querySelector<HTMLButtonElement>('[data-testid="property-value"]')!)
      await vi.waitFor(() => {
        expect(document.querySelector(`[data-testid="property-value-day"][data-date="${picked}"]`)).not.toBeNull()
      })
      await act(async () => {
        document.querySelector<HTMLElement>(`[data-testid="property-value-day"][data-date="${picked}"]`)!.click()
      })
      expect(host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')?.disabled).toBe(false)
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')!.click()
      })
      expect(vault.active?.properties.deadline).toBe(picked)
      // the new row renders the calendar control, not a text input
      expect(
        host.querySelector('[data-testid="property-field"][data-name="deadline"] [data-testid="date-input"]'),
      ).not.toBeNull()
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('keeps one add-property button and closes the form when the active note changes', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const first = vault.activeId
    vault.updateTitle('Alpha')
    await vault.createNote()
    const second = vault.activeId
    vault.updateTitle('Beta')
    await vault.createNote()
    vault.updateTitle('Gamma')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const addButtons = () => host.querySelectorAll('[data-testid="add-property-open"]')
    try {
      await act(async () => {
        root.render(<PropertiesPanel />)
      })
      expect(addButtons()).toHaveLength(1)
      expect(host.querySelectorAll('.properties-panel')).toHaveLength(1)

      await openAddPropertyForm(host)
      expect(host.querySelector('[data-testid="property-name"]')).not.toBeNull()

      await act(async () => {
        vault.select(first)
      })
      expect(addButtons()).toHaveLength(1)
      expect(host.querySelector('[data-testid="property-name"]')).toBeNull()

      await act(async () => {
        vault.select(second)
      })
      await act(async () => {
        vault.select(first)
      })
      await act(async () => {
        vault.select(second)
      })
      expect(addButtons()).toHaveLength(1)
      expect(host.querySelectorAll('.properties-panel')).toHaveLength(1)
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('shows the current title in the other note after a filename rename', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Alpha')
    await vault.commitHeadingRename()
    const alphaId = vault.activeId

    await vault.createNote()
    vault.updateTitle('Beta')
    await vault.commitHeadingRename()
    vault.linkRelation('related_to', alphaId)
    vault.updateDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'wikilink', attrs: { target: 'Alpha' } }],
        },
      ],
    })
    await vault.flush()
    const betaId = vault.activeId

    vault.activeId = alphaId
    vault.updateTitle('Alpha Renamed')
    await vault.commitHeadingRename()
    const renamed = vault.notes.find((note) => note.title === 'Alpha Renamed')
    expect(renamed?.id).not.toBe(alphaId)

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        vault.activeId = betaId
        root.render(<PropertiesPanel />)
      })
      const links = [...host.querySelectorAll<HTMLElement>('[data-testid="relation-link"]')]
      // property link and body link to the same target merge into one row,
      // tagged with the structural kind
      expect(links.map((link) => link.textContent)).toEqual(['Related toAlpha Renamed'])
      expect(links.map((link) => link.dataset.target)).toEqual([renamed?.id])
      expect(links[0].textContent).not.toContain('[[Alpha]]')

      await act(async () => {
        vault.activeId = renamed?.id ?? ''
      })
      const backlink = host.querySelector<HTMLElement>('[data-testid="backlink"]')
      expect(backlink?.textContent).toContain('Beta')
      expect(backlink?.dataset.source).toBe(betaId)
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
