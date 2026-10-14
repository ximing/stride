import { useState, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitChange } from '../../../../packages/core/src/git-changes.ts'
import { GitPanelView } from './git-panel'

const changes: GitChange[] = [
  { path: 'notes/a.stride.json', code: ' M', staged: false, unstaged: true, untracked: false, unmerged: false },
  { path: 'notes/b.stride.json', code: 'M ', staged: true, unstaged: false, untracked: false, unmerged: false },
  { path: 'notes/c.stride.json', code: '??', staged: false, unstaged: false, untracked: true, unmerged: false },
]

function setControlValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
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
  browserNeedsInit?: boolean
  error?: string
}) {
  const [selected, setSelected] = useState<string[]>([...(props.initialSelected ?? [])])
  const [message, setMessage] = useState('')
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
      browserNeedsInit={props.browserNeedsInit}
      error={props.error}
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

  it('offers init only when the vault needs a repository', async () => {
    let inits = 0
    await render(<Harness surface="needs-init" branch="" changes={changes} onInit={() => { inits += 1 }} />)
    expect(host?.querySelector('[data-testid="git-init"]')).not.toBeNull()
    expect(host?.textContent).toContain('This vault is not a Git repository.')
    expect(host?.querySelector('[data-testid="git-change"]')).toBeNull()
    expect(host?.querySelector('[data-testid="git-commit-open"]')).toBeNull()
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
})
