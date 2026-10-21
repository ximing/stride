import { Notebook as Note } from 'lucide-react'
import { register, resolve } from '@rabjs/react'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../app'
import { FolderService } from '../../services/vault/folder.service'
import { ChatService } from '../../services/chat/chat.service'
import { GitService } from '../../services/git/git.service'
import { SettingsService } from '../../services/settings/settings.service'
import { UpdateService } from '../../services/update/update.service'
import { VaultService } from '../../services/vault/vault.service'
import { ChatPanel } from '../chat/chat-panel'
import { EmptyState, Skeleton } from './empty-state'
import { TocPanel } from '../panels/toc-panel'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function host(): { host: HTMLDivElement; root: Root } {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return { host: element, root: createRoot(element) }
}

async function render(root: Root, node: ReactNode) {
  await act(async () => {
    root.render(node)
  })
}

async function unmount(element: HTMLDivElement, root: Root) {
  await act(async () => {
    root.unmount()
  })
  element.remove()
}

describe('EmptyState', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('renders title, body and a working action; error tone marks the root', async () => {
    const onAction = vi.fn()
    const { host: element, root } = host()
    try {
      await render(
        root,
        <EmptyState
          icon={Note}
          title="Nothing here"
          body="A helpful hint."
          tone="error"
          actionLabel="Retry"
          actionTestId="es-action"
          onAction={onAction}
          testId="es"
        />,
      )
      const el = element.querySelector('[data-testid="es"]')!
      expect(el.textContent).toContain('Nothing here')
      expect(el.textContent).toContain('A helpful hint.')
      expect(el.getAttribute('data-tone')).toBe('error')
      expect(el.querySelector('.sd-empty-state-icon')).not.toBeNull()
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="es-action"]')!.click()
      })
      expect(onAction).toHaveBeenCalledTimes(1)
    } finally {
      await unmount(element, root)
    }
  })

  it('omits icon, body and action when not given', async () => {
    const { host: element, root } = host()
    try {
      await render(root, <EmptyState compact title="Just a hint" testId="es-min" />)
      const el = element.querySelector('[data-testid="es-min"]')!
      expect(el.querySelector('.sd-empty-state-icon')).toBeNull()
      expect(el.querySelector('.sd-empty-state-body')).toBeNull()
      expect(el.querySelector('button')).toBeNull()
      expect(el.getAttribute('data-tone')).toBeNull()
    } finally {
      await unmount(element, root)
    }
  })

  it('skeleton renders the requested rows', async () => {
    const { host: element, root } = host()
    try {
      await render(root, <Skeleton rows={5} testId="sk" />)
      expect(element.querySelectorAll('[data-testid="sk"] .sd-skeleton-row')).toHaveLength(5)
    } finally {
      await unmount(element, root)
    }
  })
})

describe('panel empty/error states', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  async function openEmptyVault() {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    register(GitService)
    register(SettingsService)
    register(ChatService)
    register(UpdateService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await act(async () => {
      vault.notes = []
      vault.activeId = ''
    })
    return vault
  }

  it('shows a branded stage placeholder and creates a note from it', async () => {
    const vault = await openEmptyVault()
    const { host: element, root } = host()
    try {
      await render(root, <App />)
      expect(element.querySelector('[data-testid="stage-empty"]')).not.toBeNull()
      expect(element.querySelector('[data-testid="note-list-empty-vault"]')).not.toBeNull()
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="stage-new-note"]')!.click()
      })
      expect(vault.notes.length).toBe(1)
      expect(element.querySelector('[data-testid="stage-empty"]')).toBeNull()
      expect(element.querySelector('[data-testid="note-title"]')).not.toBeNull()
    } finally {
      vault.cancelPending()
      await unmount(element, root)
    }
  })

  it('offers a retry next to a failed save and saves on click', async () => {
    const vault = await openEmptyVault()
    const { host: element, root } = host()
    try {
      await render(root, <App />)
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="stage-new-note"]')!.click()
      })
      expect(element.querySelector('[data-testid="save-retry"]')).toBeNull()
      await act(async () => {
        vault.updateTitle('Retry me')
        vault.saveStatus = 'error'
      })
      const retry = element.querySelector<HTMLButtonElement>('[data-testid="save-retry"]')
      expect(retry).not.toBeNull()
      await act(async () => {
        retry!.click()
      })
      expect(vault.saveStatus).toBe('saved')
      expect(element.querySelector('[data-testid="save-retry"]')).toBeNull()
    } finally {
      vault.cancelPending()
      await unmount(element, root)
    }
  })

  it('turns the index status into a retry button after a failure', async () => {
    const vault = await openEmptyVault()
    const { host: element, root } = host()
    try {
      await render(root, <App />)
      await act(async () => {
        vault.indexPhase = 'error'
      })
      const status = element.querySelector<HTMLButtonElement>('[data-testid="index-status"]')
      expect(status).not.toBeNull()
      expect(element.querySelector('[data-testid="index-retry"]')).not.toBeNull()
      await act(async () => {
        status!.click()
      })
      // Empty vault: the retried rebuild settles straight to ready.
      expect(vault.indexPhase).toBe('ready')
      expect(element.querySelector('[data-testid="index-retry"]')).toBeNull()
    } finally {
      vault.cancelPending()
      await unmount(element, root)
    }
  })

  it('shows the quick-open empty-vault hint', async () => {
    const vault = await openEmptyVault()
    const { host: element, root } = host()
    try {
      await render(root, <App />)
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true }))
      })
      expect(element.querySelector('[data-testid="quick-open-empty"]')?.textContent).toContain('还没有笔记')
    } finally {
      vault.cancelPending()
      await unmount(element, root)
    }
  })

  it('guides an empty chat session and flags chat errors', async () => {
    useMemoryFixture()
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      expect(element.querySelector('[data-testid="chat-empty"]')).not.toBeNull()
      await act(async () => {
        resolve(ChatService).error = 'boom'
      })
      expect(element.querySelector('[data-testid="chat-error"]')?.textContent).toBe('boom')
    } finally {
      resolve(ChatService).error = ''
      await unmount(element, root)
    }
  })

  it('distinguishes no-note and no-headings in the outline panel', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    const { host: element, root } = host()
    try {
      await render(root, <TocPanel />)
      expect(element.querySelector('[data-testid="toc-empty"]')).not.toBeNull()
      await act(async () => {
        vault.notes = [
          { id: 'n1', title: 'Flat note', type: 'note', properties: {}, doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
        ]
        vault.activeId = 'n1'
      })
      expect(element.querySelector('[data-testid="toc-empty"]')).toBeNull()
      expect(element.querySelector('[data-testid="toc-empty-headings"]')).not.toBeNull()
      await act(async () => {
        vault.notes = [
          {
            id: 'n1',
            title: 'Structured',
            type: 'note',
            properties: {},
            doc: {
              type: 'doc',
              content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] }],
            },
          },
        ]
      })
      expect(element.querySelector('[data-testid="toc-empty-headings"]')).toBeNull()
      expect(element.querySelectorAll('[data-testid="toc-item"]').length).toBeGreaterThan(1)
    } finally {
      await unmount(element, root)
    }
  })
})
