import { register, resolve } from '@rabjs/react'
import { plainText } from '@stride/core/note'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readNoteFile } from '../../../../packages/core/src/vault'
import { Rail } from '../app'
import { VaultService } from './vault.service'

let root: Root | undefined

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function typeLinks(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="type-link"]')]
}

function typeNames(host: HTMLElement): string[] {
  return typeLinks(host).map((node) => node.dataset.type ?? '')
}

function typeLabels(host: HTMLElement): string[] {
  return typeLinks(host).map((node) => node.querySelector('.type-label')?.textContent ?? '')
}

function noteTitles(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-testid="note-link"]')].map((node) => node.textContent ?? '')
}

async function click(host: HTMLElement, selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector)
  if (!button) throw new Error(`missing ${selector}`)
  await act(async () => {
    button.click()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  })
}

async function mountRail(): Promise<{ host: HTMLElement; vault: VaultService }> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  const vault = resolve(VaultService)
  vault.collapsedTypes = []
  vault.cancelPending()
  localStorage.removeItem('stride:collapsed-types')
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<Rail />)
  })
  return { host, vault }
}

describe('type rail', () => {
  afterEach(() => {
    root?.unmount()
    root = undefined
    document.body.replaceChildren()
    localStorage.clear()
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    try {
      const vault = resolve(VaultService)
      vault.cancelPending()
      vault.collapsedTypes = []
    } catch {
      // The service is registered by the cases that render the rail.
    }
  })

  it('orders visible types, hides visible=false, and collapses row actions only', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.createNewVault()
    })
    expect(typeNames(host)).toEqual(['Note', 'Project', 'Person'])
    expect(typeLabels(host)).toEqual(['Notes', 'Projects', 'People'])
    expect(typeLinks(host).map((node) => node.dataset.icon)).toEqual(['note', 'briefcase', 'user'])
    expect(typeLinks(host).map((node) => node.querySelector('.type-dot')?.className)).toEqual([
      'type-dot type-dot-gray',
      'type-dot type-dot-blue',
      'type-dot type-dot-teal',
    ])

    await act(async () => {
      vault.select('note')
      vault.updateProperty('_order', '40')
      vault.updateProperty('_icon', 'nope')
      vault.updateProperty('_color', 'lime')
    })
    expect(typeNames(host)).toEqual(['Project', 'Person', 'Note'])
    const noteLink = typeLinks(host).find((node) => node.dataset.type === 'Note')
    expect(noteLink?.dataset.icon).toBe('note')
    expect(noteLink?.querySelector('.type-dot')?.className).toContain('type-dot-gray')

    await act(async () => {
      vault.select('person')
      vault.updateProperty('visible', 'false')
    })
    expect(typeNames(host)).toEqual(['Project', 'Note'])
    expect(host.querySelector('[data-testid="type-link"][data-type="Person"]')).toBeNull()

    await act(async () => {
      await vault.createNote()
      vault.updateType('Project')
      vault.setFilter('Project')
    })
    expect(noteTitles(host)).toEqual(['Untitled'])

    await click(host, '[data-testid="type-collapse"][data-type="Project"]')
    expect(host.querySelector('[data-testid="type-link"][data-type="Project"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="type-new-instance"][data-type="Project"]')).toBeNull()
    expect(noteTitles(host)).toEqual(['Untitled'])
    expect(vault.listFilter).toBe('Project')
    expect(vault.collapsedTypes).toEqual(['Project'])
    expect(JSON.parse(localStorage.getItem('stride:collapsed-types') ?? '[]')).toEqual(['Project'])

    await click(host, '[data-testid="type-collapse"][data-type="Project"]')
    expect(host.querySelector('[data-testid="type-new-instance"][data-type="Project"]')).not.toBeNull()
    expect(vault.collapsedTypes).toEqual([])
    expect(noteTitles(host)).toEqual(['Untitled'])
  })

  it('creates a Type document, applies a template paragraph, and lists instances', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.createNewVault()
    })

    await act(async () => {
      vault.select('note')
    })
    expect(host.querySelector('[data-testid="type-instances"]')?.textContent).toContain('No instances yet.')

    await act(async () => {
      vault.select('project')
      vault.updateProperty('template', 'Bring a pencil.')
    })
    await click(host, '[data-testid="type-new-instance"][data-type="Project"]')

    const instance = vault.active
    expect(instance?.type).toBe('Project')
    expect(instance?.title).toBe('Untitled')
    expect(instance?.id).toMatch(/^untitled-[a-z0-9]{4}$/)
    expect(vault.listFilter).toBe('Project')
    expect(instance?.doc.content?.map((node) => node.type)).toEqual(['paragraph'])
    expect(plainText(instance?.doc ?? { type: 'doc' })).toBe('Bring a pencil.')
    expect(instance?.doc.content?.some((node) => node.type === 'heading')).toBe(false)

    const saved = await readNoteFile(vault.fs!, `${instance?.id}.stride.json`, instance?.id)
    expect(saved.type).toBe('Project')
    expect(saved.title).toBe('Untitled')
    expect(saved.doc.content?.map((node) => node.type)).toEqual(['paragraph'])
    expect(plainText(saved.doc)).toBe('Bring a pencil.')
    expect(JSON.stringify(saved.doc)).not.toContain('Untitled')

    const instanceId = instance?.id ?? ''
    await act(async () => {
      vault.select('project')
    })
    const links = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="instance-link"]')]
    expect(links.map((node) => node.textContent)).toEqual(['Untitled'])
    expect(host.querySelector('[data-testid="type-instances"]')?.textContent).not.toContain('No instances yet.')
    await click(host, '[data-testid="instance-link"]')
    expect(vault.activeId).toBe(instanceId)

    await click(host, '[data-testid="new-type"]')
    const created = vault.active
    expect(created?.type).toBe('Type')
    expect(created?.title).toBe('Untitled')
    expect(created?.id).toMatch(/^untitled-[a-z0-9]{4}$/)
    expect(created?.id).not.toBe(instanceId)
    expect(created?.properties).toMatchObject({
      _icon: 'note',
      _color: 'gray',
      visible: 'true',
      _order: '31',
    })
    const typeSaved = await readNoteFile(vault.fs!, `${created?.id}.stride.json`, created?.id)
    expect(typeSaved.type).toBe('Type')
    expect(typeNames(host)).toEqual(['Note', 'Project', 'Person', 'Untitled'])
    expect(host.querySelector('[data-testid="type-instances"]')?.textContent).toContain('No instances yet.')
    expect(vault.error).toBe('')
  })

  it('reopens the type document from the type row after another note is selected', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.createNewVault()
      await vault.createNote()
    })
    const otherId = vault.activeId

    await act(async () => {
      vault.select('project')
      vault.updateProperty('template', 'Bring a pencil.')
    })
    await click(host, '[data-testid="type-new-instance"][data-type="Project"]')
    const instanceTitle = vault.active?.title ?? ''
    expect(instanceTitle).not.toBe('')
    expect(vault.activeId).not.toBe(otherId)

    await act(async () => {
      vault.select(otherId)
    })
    expect(vault.activeId).toBe(otherId)
    expect(vault.active?.type).not.toBe('Type')
    expect(host.querySelector('[data-testid="type-instances"]')).toBeNull()

    await click(host, '[data-testid="type-link"][data-type="Project"]')
    expect(vault.active?.id).toBe('project')
    expect(vault.active?.type).toBe('Type')
    expect(vault.listFilter).toBe('Project')
    expect(host.querySelector('[data-testid="type-instances"]')?.textContent).toContain(instanceTitle)
  })

  it('falls back to note.type groups when the vault has no type documents', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
      await vault.createNote()
      vault.updateType('Journal')
    })
    expect(host.querySelector('[data-testid="type-link"]')).toBeNull()
    const fallback = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Journal')
    expect(fallback).toBeTruthy()
    await act(async () => {
      fallback?.click()
    })
    expect(vault.listFilter).toBe('Journal')
    expect(noteTitles(host)).toEqual(['Untitled'])
  })
})
