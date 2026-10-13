import { register, resolve } from '@rabjs/react'
import type { StrideNote } from '@stride/core/note'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { readNoteFile } from '../../../../packages/core/src/vault'
import { VaultService } from '../services/vault.service'
import { PropertiesPanel } from './properties-panel'

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

function setControlValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('PropertiesPanel', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
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

      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'count')
        setControlValue(host.querySelector<HTMLSelectElement>('[data-testid="property-type"]')!, 'number')
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-value"]')!, '12')
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')!.click()
      })

      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'done')
        setControlValue(host.querySelector<HTMLSelectElement>('[data-testid="property-type"]')!, 'boolean')
      })
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
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'label')
        setControlValue(host.querySelector<HTMLSelectElement>('[data-testid="property-type"]')!, 'string')
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-value"]')!, 'solo')
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="add-property"]')!.click()
      })
      await act(async () => {
        setControlValue(host.querySelector<HTMLInputElement>('[data-testid="property-name"]')!, 'tags')
        setControlValue(host.querySelector<HTMLSelectElement>('[data-testid="property-type"]')!, 'list')
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
      expect(toB?.textContent).toContain('body')
      expect(backToB).not.toBeNull()
      await act(async () => {
        toB!.click()
      })
      expect(vault.activeId).toBe('note-b')

      const toA = host.querySelector<HTMLButtonElement>('[data-testid="relation-link"][data-target="note-a"]')
      const backToA = host.querySelector<HTMLButtonElement>('[data-testid="backlink"][data-source="note-a"]')
      expect(toA).not.toBeNull()
      expect(toA?.textContent).toContain('related_to')
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
})
