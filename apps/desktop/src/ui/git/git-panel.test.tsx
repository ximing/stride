import { useState, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitChange } from '../../../../../packages/core/src/git-changes.ts'
import { GitPanelView } from './git-panel'

const changes: GitChange[] = [
  { path: 'notes/a.stride.json', code: ' M', staged: false, unstaged: true, untracked: false, unmerged: false },
  { path: 'notes/b.stride.json', code: 'M ', staged: true, unstaged: false, untracked: false, unmerged: false },
  { path: 'notes/c.stride.json', code: '??', staged: false, unstaged: false, untracked: true, unmerged: false },
]

function setControlValue(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function Harness(props: {
  surface?: 'unavailable' | 'disabled' | 'blocked' | 'needs-init' | 'ready'
  branch?: string
  changes?: GitChange[]
  diff?: string
  ahead?: number
  behind?: number
  suggesting?: boolean
  notice?: string
  initialSelected?: readonly string[]
  onCommit?: (paths: string[]) => void
  onSuggest?: () => void
  onOpenFileDiff?: (path: string) => void
  onInit?: () => void
  onPull?: () => void
  onPush?: () => void
  onAddRemote?: (url: string) => void
  browserNeedsInit?: boolean
  error?: string
  conflicts?: readonly string[]
  onKeepSide?: (path: string, side: 'ours' | 'theirs') => void
  historyEntries?: readonly { hash: string; subject: string }[]
  historyText?: string
  onShowHistory?: (rev: string) => void
  onRestoreHistory?: () => void
}) {
  const [selected, setSelected] = useState<string[]>([...(props.initialSelected ?? [])])
  const [message, setMessage] = useState('')
  const [remote, setRemote] = useState('')
  return (
    <GitPanelView
      surface={props.surface ?? 'ready'}
      branch={props.branch ?? 'main'}
      changes={props.changes ?? []}
      selected={selected}
      diff={props.diff ?? ''}
      message={message}
      ahead={props.ahead ?? 0}
      behind={props.behind ?? 0}
      suggesting={props.suggesting ?? false}
      notice={props.notice ?? ''}
      onToggle={(path) => {
        setSelected((current) => (
          current.includes(path) ? current.filter((item) => item !== path) : [...current, path]
        ))
      }}
      onMessage={setMessage}
      onOpenFileDiff={props.onOpenFileDiff ?? (() => {})}
      onCommit={props.onCommit ?? (() => {})}
      onSuggest={props.onSuggest ?? (() => {})}
      onInit={props.onInit ?? (() => {})}
      remote={remote}
      onRemote={setRemote}
      onAddRemote={() => props.onAddRemote?.(remote)}
      onPull={props.onPull ?? (() => {})}
      onPush={props.onPush ?? (() => {})}
      browserNeedsInit={props.browserNeedsInit}
      error={props.error}
      conflicts={props.conflicts}
      onKeepSide={props.onKeepSide}
      historyEntries={props.historyEntries}
      historyText={props.historyText}
      onShowHistory={props.onShowHistory}
      onRestoreHistory={props.onRestoreHistory}
    />
  )
}

describe('GitPanelView', () => {
  let root: Root | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
  })

  async function render(ui: ReactElement) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(ui)
    })
  }

  async function rerender(ui: ReactElement) {
    await act(async () => {
      root?.render(ui)
    })
  }

  it('toggles a checkbox and commits only the selected path after a message', async () => {
    const committed: string[][] = []
    const opened: string[] = []
    await render(
      <Harness
        changes={changes}
        diff={'diff --git a/notes/b.stride.json'}
        onCommit={(paths) => committed.push(paths)}
        onOpenFileDiff={(path) => opened.push(path)}
      />,
    )
    expect(host?.querySelectorAll('[data-testid="git-change"]')).toHaveLength(3)
    const open = host?.querySelector<HTMLButtonElement>('[data-testid="git-commit-open"]')
    expect(open?.disabled).toBe(true)

    const rowA = host?.querySelector<HTMLElement>('[data-testid="git-change"][data-path="notes/a.stride.json"]')
    await act(async () => {
      rowA?.click()
    })
    expect(opened).toEqual(['notes/a.stride.json'])
    expect(rowA?.querySelector<HTMLInputElement>('input')?.checked).toBe(false)

    const boxB = host?.querySelector<HTMLInputElement>('[data-testid="git-change"][data-path="notes/b.stride.json"] input')
    await act(async () => {
      boxB?.click()
    })
    expect(boxB?.checked).toBe(true)
    expect(opened).toEqual(['notes/a.stride.json'])
    expect(host?.querySelector<HTMLButtonElement>('[data-testid="git-commit-open"]')?.disabled).toBe(false)

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="git-commit-open"]')?.click()
    })
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="git-commit-confirm"]')
    const message = document.querySelector<HTMLTextAreaElement>('[data-testid="git-commit-message"]')
    expect(confirm?.disabled).toBe(true)
    await act(async () => {
      setControlValue(message!, '   ')
    })
    expect(document.querySelector<HTMLButtonElement>('[data-testid="git-commit-confirm"]')?.disabled).toBe(true)
    await act(async () => {
      setControlValue(message!, 'Save notes')
    })
    const ready = document.querySelector<HTMLButtonElement>('[data-testid="git-commit-confirm"]')
    expect(ready?.disabled).toBe(false)
    await act(async () => {
      ready?.click()
    })
    expect(committed).toEqual([['notes/b.stride.json']])
    const diff = host?.querySelector('[data-testid="git-diff"]')
    expect(diff?.tagName).toBe('PRE')
    expect(diff?.textContent).toBe('diff --git a/notes/b.stride.json')
  })

  it('colors diff add/del/hunk lines while preserving the text verbatim', async () => {
    const text = [
      'diff --git a/notes/a.md b/notes/a.md',
      '--- a/notes/a.md',
      '+++ b/notes/a.md',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
      ' context',
    ].join('\n')
    await render(<Harness changes={changes} diff={text} />)
    const diff = host?.querySelector('[data-testid="git-diff"]')
    expect(diff?.textContent).toBe(text)
    expect(diff?.querySelector('.diff-del')?.textContent).toBe('\n-old line')
    expect(diff?.querySelector('.diff-add')?.textContent).toBe('\n+new line')
    expect(diff?.querySelector('.diff-hunk')?.textContent).toBe('\n@@ -1,2 +1,2 @@')
    // Header lines that merely start with +/- stay neutral.
    const neutral = [...(diff?.querySelectorAll('.diff-line') ?? [])]
    expect(neutral.find((line) => line.textContent?.includes('--- a/notes'))?.className).toBe('diff-line')
    expect(neutral.find((line) => line.textContent?.includes('+++ b/notes'))?.className).toBe('diff-line')
  })

  it('suggests a message and disables suggest while suggesting', async () => {
    let suggestions = 0
    await render(
      <Harness
        changes={changes}
        suggesting
        initialSelected={['notes/a.stride.json']}
        onSuggest={() => { suggestions += 1 }}
      />,
    )
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="git-commit-open"]')?.click()
    })
    const suggesting = document.querySelector<HTMLButtonElement>('[data-testid="git-suggest-message"]')
    expect(suggesting?.disabled).toBe(true)
    await act(async () => {
      suggesting?.click()
    })
    expect(suggestions).toBe(0)

    await rerender(
      <Harness
        changes={changes}
        suggesting={false}
        initialSelected={['notes/a.stride.json']}
        onSuggest={() => { suggestions += 1 }}
      />,
    )
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="git-commit-open"]')?.click()
    })
    const suggest = document.querySelector<HTMLButtonElement>('[data-testid="git-suggest-message"]')
    expect(suggest?.disabled).toBe(false)
    await act(async () => {
      suggest?.click()
    })
    expect(suggestions).toBe(1)
  })

  it('shows a clean tree and disables commit when nothing is selected', async () => {
    await render(<Harness changes={[]} />)
    expect(host?.querySelector('[data-testid="git-clean"]')?.textContent).toBe('Working tree clean')
    expect(host?.querySelector('[data-testid="git-change"]')).toBeNull()
    expect(host?.querySelector<HTMLButtonElement>('[data-testid="git-commit-open"]')?.disabled).toBe(true)
  })

  it('shows ahead and behind counts', async () => {
    await render(<Harness ahead={1} behind={2} branch="main" />)
    expect(host?.querySelector('[data-testid="git-ahead"]')?.textContent).toBe('ahead 1')
    expect(host?.querySelector('[data-testid="git-behind"]')?.textContent).toBe('behind 2')
    expect(host?.querySelector('[data-testid="git-branch"]')?.textContent).toBe('main')
  })

  it('edits the remote and runs add, pull, and push', async () => {
    const events: string[] = []
    await render(
      <Harness
        onAddRemote={(url) => events.push(`add ${url}`)}
        onPull={() => events.push('pull')}
        onPush={() => events.push('push')}
      />,
    )
    const input = host?.querySelector<HTMLInputElement>('[data-testid="git-remote"]')
    expect(input).not.toBeNull()
    await act(async () => {
      setControlValue(input!, 'https://example.test/vault.git')
    })
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="git-remote-add"]')?.click()
      host?.querySelector<HTMLButtonElement>('[data-testid="git-pull"]')?.click()
      host?.querySelector<HTMLButtonElement>('[data-testid="git-push"]')?.click()
    })
    expect(events).toEqual(['add https://example.test/vault.git', 'pull', 'push'])
  })

  it('offers init only when the vault needs a repository', async () => {
    let inits = 0
    await render(<Harness surface="needs-init" branch="" changes={changes} onInit={() => { inits += 1 }} />)
    expect(host?.querySelector('[data-testid="git-init"]')).not.toBeNull()
    expect(host?.textContent).toContain('This vault is not a Git repository.')
    expect(host?.querySelector('[data-testid="git-change"]')).toBeNull()
    expect(host?.querySelector('[data-testid="git-commit-open"]')).toBeNull()
    expect(host?.querySelector('[data-testid="git-remote"]')).toBeNull()
    expect(host?.querySelector('[data-testid="git-pull"]')).toBeNull()
    expect(host?.querySelector('[data-testid="git-push"]')).toBeNull()
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="git-init"]')?.click()
    })
    expect(inits).toBe(1)
  })

  it('renders the other git surfaces with their copy', async () => {
    await render(<Harness surface="unavailable" branch="" />)
    expect(host?.querySelector('[data-testid="git-unavailable"]')?.textContent).toBe('Git is not available in the browser')
    expect(host?.querySelector('[data-testid="git-needs-init"]')).toBeNull()
    expect(host?.querySelector('[data-testid="git-init"]')).toBeNull()

    await rerender(<Harness surface="unavailable" branch="" browserNeedsInit error="index locked" />)
    expect(host?.querySelector('[data-testid="git-needs-init"]')?.textContent).toBe(
      'This vault is not a Git repository. Initialize it in the desktop app.',
    )
    expect(host?.querySelector('[data-testid="git-init"]')).toBeNull()
    expect(host?.querySelector('[data-testid="git-error"]')?.textContent).toBe('index locked')

    await rerender(<Harness surface="disabled" branch="" />)
    expect(host?.querySelector('[data-testid="git-disabled"]')?.textContent).toBe('Git is turned off.')

    await rerender(<Harness surface="blocked" branch="" notice="This folder is too broad." />)
    expect(host?.querySelector('[data-testid="git-blocked"]')?.textContent).toBe('This folder is too broad.')
    expect(host?.querySelector('[data-testid="git-change"]')).toBeNull()
  })

  it('shows a conflict modal and keeps a side without a second confirmation', async () => {
    const kept: Array<[string, 'ours' | 'theirs']> = []
    await render(<Harness conflicts={[]} />)
    expect(document.querySelector('[data-testid="git-conflict"]')).toBeNull()

    await rerender(
      <Harness
        conflicts={['notes/a.md', 'notes/b.md']}
        onKeepSide={(path, side) => kept.push([path, side])}
      />,
    )
    const modal = document.querySelector('[data-testid="git-conflict"]')
    expect(modal).not.toBeNull()
    expect(modal?.textContent).toContain('notes/a.md')
    expect(modal?.textContent).toContain('notes/b.md')
    expect(document.body.textContent?.toLowerCase()).not.toContain('discard all')
    const ours = document.querySelector<HTMLButtonElement>('[data-testid="git-keep-ours"][data-path="notes/b.md"]')
    const theirs = document.querySelector<HTMLButtonElement>('[data-testid="git-keep-theirs"][data-path="notes/a.md"]')
    expect(ours).not.toBeNull()
    expect(theirs).not.toBeNull()
    await act(async () => {
      ours?.click()
      theirs?.click()
    })
    expect(kept).toEqual([
      ['notes/b.md', 'ours'],
      ['notes/a.md', 'theirs'],
    ])
    expect(document.querySelectorAll('[data-testid="git-conflict"]')).toHaveLength(1)
  })

  it('opens a restore confirm and writes nothing until confirm', async () => {
    const restored: string[] = []
    const shown: string[] = []
    await render(
      <Harness
        historyEntries={[{ hash: 'abc', subject: 'Add note' }]}
        historyText="previous"
        onShowHistory={(rev) => shown.push(rev)}
        onRestoreHistory={() => restored.push('restore')}
      />,
    )
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="git-history-row"]')?.click()
    })
    expect(shown).toEqual(['abc'])
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="git-history-restore"]')?.click()
    })
    expect(restored).toEqual([])
    expect(document.querySelector('[data-testid="git-history-restore-confirm"]')).not.toBeNull()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="git-history-restore-confirm"]')?.click()
    })
    expect(restored).toEqual(['restore'])
  })
})
