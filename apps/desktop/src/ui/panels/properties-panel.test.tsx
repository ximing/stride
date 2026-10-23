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
      expect(host.querySelector('[data-testid="relation-group-body"]')?.textContent).toContain('Body links')
      expect(backToB).not.toBeNull()
      await act(async () => {
        toB!.click()
      })
      expect(vault.activeId).toBe('note-b')

      const toA = host.querySelector<HTMLButtonElement>('[data-testid="relation-link"][data-target="note-a"]')
      const backToA = host.querySelector<HTMLButtonElement>('[data-testid="backlink"][data-source="note-a"]')
      expect(toA).not.toBeNull()
      expect(host.querySelector('[data-testid="relation-group-related_to"]')?.textContent).toContain('Related to')
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
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="relation-query"]')!, 'note b')
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="relation-match"][data-target="note-b"]')!.click()
      })
      expect(vault.notes.find((note) => note.id === 'note-a')?.properties.belongs_to).toEqual(['[[Note B]]'])
      expect(host.querySelector('[data-testid="property-field"][data-name="belongs_to"]')).toBeNull()
      expect(host.textContent).toContain('Belongs to')
      expect(vault.notes.find((note) => note.id === 'note-b')?.properties.has).toBeUndefined()

      const kind = host.querySelector<HTMLButtonElement>('[data-testid="relation-kind"]')!
      await act(async () => {
        kind.click()
      })
      const related = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === 'Related to')
      expect(related).not.toBeNull()
      await act(async () => {
        ;(related as HTMLElement).click()
      })
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="relation-query"]')!, 'note b')
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="relation-match"][data-target="note-b"]')!.click()
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

      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="archive-note"]')!.click()
      })
      expect(linkText()).not.toContain('Archived note')
      expect(linkText()).toContain('Kept note')
      expect(host.querySelector<HTMLInputElement>('[data-testid="note-title"]')?.value).toBe('Archived note')
      vault.cancelPending()

      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="delete-note"]')!.click()
      })
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="cancel-delete"]')!.click()
      })
      expect(await vault.fs!.stat(notePath(id))).not.toBeNull()
      expect(await vault.fs!.stat(notePath(keptId))).not.toBeNull()

      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="delete-note"]')!.click()
      })
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
})
