import type { Editor } from '@tiptap/core'
import { bindServices, observer, useService } from '@rabjs/react'
import { useEffect, useRef } from 'react'
import { CommandService } from '../services/command.service'
import {
  FindService,
  clearFindHighlight,
  findTextMatches,
  matchIndex,
  replaceAllMatches,
  replaceOneMatch,
  selectMatch,
} from './find'

function countLabel(count: number, index: number): string {
  if (count === 0) return '0'
  return `${matchIndex(index, count) + 1}/${count}`
}

const FindBar = observer(function FindBar({ editor }: { editor: Editor }) {
  const service = useService(FindService)
  const commands = useService(CommandService)
  const inputRef = useRef<HTMLInputElement>(null)
  // Bumped on editor updates so the count follows the document, not only the query.
  const revision = service.revision
  const matches = findTextMatches(editor.state.doc, service.query)
  void revision

  useEffect(() => {
    const onUpdate = () => {
      if (service.open) service.bump()
    }
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
    }
  }, [editor, service])

  useEffect(() => {
    if (!service.open) {
      clearFindHighlight(editor)
      return
    }
    inputRef.current?.focus()
    const found = findTextMatches(editor.state.doc, service.query)
    const current = found[matchIndex(service.index, found.length)]
    if (current) selectMatch(editor, current)
  }, [editor, service, service.open])

  // The manifest owns Mod+F; the find handler lives here because FindService
  // is bound to this component and the input ref is local.
  useEffect(
    () =>
      commands.registerHandler('edit.find', {
        run: () => {
          if (service.open) inputRef.current?.focus()
          else service.show()
        },
      }),
    [commands, service],
  )

  useEffect(() => {
    const step = (delta: number) => {
      const found = findTextMatches(editor.state.doc, service.query)
      if (found.length === 0) return
      const index = matchIndex(service.index + delta, found.length)
      service.setIndex(index)
      const match = found[index]
      if (match) selectMatch(editor, match)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // Shortcut bindings come from the command manifest; the dispatcher runs them.
      if (commands.dispatchKeydown(event)) return
      if (!service.open || event.isComposing) return
      const target = event.target instanceof Element ? event.target : null
      if (event.key === 'Enter' && target?.closest('[data-testid="find-bar"]')) {
        event.preventDefault()
        event.stopPropagation()
        step(event.shiftKey ? -1 : 1)
        return
      }
      if (event.key !== 'Escape') return
      if (target?.closest('[data-testid="search-panel"], [data-testid="quick-open"], [data-testid="command-palette"]')) return
      event.preventDefault()
      event.stopPropagation()
      service.close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [editor, service, commands])

  function revealQuery(value: string) {
    service.setQuery(value)
    const found = findTextMatches(editor.state.doc, value)
    const first = found[0]
    if (!first) {
      clearFindHighlight(editor)
      return
    }
    selectMatch(editor, first)
  }

  function step(delta: number) {
    const found = findTextMatches(editor.state.doc, service.query)
    if (found.length === 0) return
    const index = matchIndex(service.index + delta, found.length)
    service.setIndex(index)
    const match = found[index]
    if (match) selectMatch(editor, match)
  }

  function replaceCurrent() {
    const query = service.query
    if (!query) return
    const found = findTextMatches(editor.state.doc, query)
    if (found.length === 0) return
    const index = matchIndex(service.index, found.length)
    if (!replaceOneMatch(editor, query, index, service.replacement)) return
    const next = findTextMatches(editor.state.doc, query)
    service.setIndex(next.length === 0 ? 0 : Math.min(index, next.length - 1))
  }

  function replaceEvery() {
    if (!service.query) return
    if (replaceAllMatches(editor, service.query, service.replacement) === 0) return
    service.setIndex(0)
  }

  if (!service.open) return null

  return (
    <div className="find-bar" data-testid="find-bar" role="search">
      <input
        ref={inputRef}
        className="find-input"
        data-testid="find-input"
        aria-label="查找"
        placeholder="查找"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={service.query}
        onChange={(event) => revealQuery(event.target.value)}
      />
      <span className="find-count" data-testid="find-count">{countLabel(matches.length, service.index)}</span>
      <button type="button" data-testid="find-prev" aria-label="上一个" onMouseDown={(event) => event.preventDefault()} onClick={() => step(-1)}>
        上一个
      </button>
      <button type="button" data-testid="find-next" aria-label="下一个" onMouseDown={(event) => event.preventDefault()} onClick={() => step(1)}>
        下一个
      </button>
      <input
        className="replace-input"
        data-testid="replace-input"
        aria-label="替换为"
        placeholder="替换为"
        autoComplete="off"
        spellCheck={false}
        value={service.replacement}
        onChange={(event) => service.setReplacement(event.target.value)}
      />
      <button type="button" data-testid="replace-one" aria-label="替换" onMouseDown={(event) => event.preventDefault()} onClick={replaceCurrent}>
        替换
      </button>
      <button type="button" data-testid="replace-all" aria-label="全部替换" onMouseDown={(event) => event.preventDefault()} onClick={replaceEvery}>
        全部替换
      </button>
      <button type="button" aria-label="关闭" onMouseDown={(event) => event.preventDefault()} onClick={() => service.close()}>
        关闭
      </button>
    </div>
  )
})

export const EditorFind = bindServices(FindBar, [FindService])
