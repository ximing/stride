import type { Editor } from '@tiptap/core'
import { bindServices, observer, useService } from '@rabjs/react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { CommandService } from '../../services/commands/command.service'
import { findKeywordHits, findSeedFromSelection, nextHitIndex } from './find-hits'
import { imeBlocksEnterFromEvent, runAfterImeEnter } from '../ime-enter'
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
  const { t } = useTranslation()
  const service = useService(FindService)
  const commands = useService(CommandService)
  const inputRef = useRef<HTMLInputElement>(null)
  // Bumped on editor updates so the count follows the document, not only the query.
  const revision = service.revision
  const caseSensitive = service.caseSensitive
  const matches = findTextMatches(editor.state.doc, service.query, caseSensitive)
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
    window.dispatchEvent(new CustomEvent('stride-editor-find-open', { detail: { open: service.open } }))
    return () => {
      window.dispatchEvent(new CustomEvent('stride-editor-find-open', { detail: { open: false } }))
    }
  }, [service.open])

  useEffect(() => {
    if (!service.open) {
      clearFindHighlight(editor)
      return
    }
    inputRef.current?.focus()
    const found = findTextMatches(editor.state.doc, service.query, service.caseSensitive)
    const current = found[matchIndex(service.index, found.length)]
    if (current) selectMatch(editor, current)
  }, [editor, service, service.open])

  // The manifest owns Mod+F; the find handler lives here because FindService
  // is bound to this component and the input ref is local.
  useEffect(
    () =>
      commands.registerHandler('edit.find', {
        run: () => {
          const { from, to } = editor.state.selection
          const seed = findSeedFromSelection(editor.state.doc, from, to)
          if (seed) service.setQuery(seed)
          if (service.open) {
            inputRef.current?.focus()
            const query = seed ?? service.query
            const found = findTextMatches(editor.state.doc, query, service.caseSensitive)
            const current = found[matchIndex(service.index, found.length)]
            if (current) selectMatch(editor, current)
            else clearFindHighlight(editor)
          } else service.show()
        },
      }),
    [commands, editor, service],
  )

  useEffect(() => {
    const step = (delta: number) => {
      const found = findTextMatches(editor.state.doc, service.query, service.caseSensitive)
      if (found.length === 0) return
      const index = matchIndex(service.index + delta, found.length)
      service.setIndex(index)
      const match = found[index]
      if (match) selectMatch(editor, match)
    }
    const onFind = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail = event.detail as { seed?: unknown } | null
      const seed = detail && typeof detail.seed === 'string' ? detail.seed : ''
      if (seed) service.setQuery(seed)
      if (service.open) inputRef.current?.focus()
      else service.show()
      if (!seed) return
      const found = findTextMatches(editor.state.doc, seed, service.caseSensitive)
      const first = found[0]
      if (first) selectMatch(editor, first)
      else clearFindHighlight(editor)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // Shortcut bindings come from the command manifest; the dispatcher runs them.
      if (commands.dispatchKeydown(event)) return
      if (!service.open) return
      const target = event.target instanceof Element ? event.target : null
      if (event.key === 'Enter' && target?.closest('[data-testid="find-bar"]')) {
        if (imeBlocksEnterFromEvent(event)) return
        event.preventDefault()
        event.stopPropagation()
        const backward = event.shiftKey
        runAfterImeEnter(event, () => step(backward ? -1 : 1))
        return
      }
      if (event.key !== 'Escape') return
      if (target?.closest('[data-testid="search-panel"], [data-testid="quick-open"], [data-testid="command-palette"]')) return
      event.preventDefault()
      event.stopPropagation()
      service.close()
    }
    window.addEventListener('stride-editor-find', onFind)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('stride-editor-find', onFind)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [editor, service, commands])

  function revealQuery(value: string) {
    service.setQuery(value)
    const found = findTextMatches(editor.state.doc, value, service.caseSensitive)
    const first = found[0]
    if (!first) {
      clearFindHighlight(editor)
      return
    }
    selectMatch(editor, first)
  }

  function step(delta: number) {
    const found = findTextMatches(editor.state.doc, service.query, service.caseSensitive)
    if (found.length === 0) return
    const index = matchIndex(service.index + delta, found.length)
    service.setIndex(index)
    const match = found[index]
    if (match) selectMatch(editor, match)
  }

  function toggleCase() {
    service.toggleCase()
    const found = findTextMatches(editor.state.doc, service.query, service.caseSensitive)
    const first = found[0]
    if (!first) {
      clearFindHighlight(editor)
      return
    }
    selectMatch(editor, first)
  }

  function replaceCurrent() {
    const query = service.query
    if (!query) return
    const hits = findKeywordHits(editor.state.doc, query, service.caseSensitive)
    if (hits.length === 0) return
    const index = matchIndex(service.index, hits.length)
    const hit = hits[index]
    if (!hit || !replaceOneMatch(editor, query, index, service.replacement, service.caseSensitive)) return
    const next = findKeywordHits(editor.state.doc, query, service.caseSensitive)
    const mappedEnd = hit.kind === 'text' ? hit.from + service.replacement.length : hit.to
    const nextIndex = nextHitIndex(next, hit, service.replacement.length, mappedEnd)
    service.setIndex(nextIndex)
    const chosen = next[nextIndex]
    if (chosen) selectMatch(editor, { from: chosen.from, to: chosen.to })
  }

  function replaceEvery() {
    if (!service.query) return
    if (replaceAllMatches(editor, service.query, service.replacement, service.caseSensitive) === 0) return
    service.setIndex(0)
  }

  if (!service.open) return null

  return (
    <div className="find-bar" data-testid="find-bar" role="search">
      <input
        ref={inputRef}
        className="find-input"
        data-testid="find-input"
        aria-label={t('editor.find.find')}
        placeholder={t('editor.find.find')}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={service.query}
        onChange={(event) => revealQuery(event.target.value)}
      />
      <button
        type="button"
        className="find-case"
        data-testid="find-case"
        aria-label={t('editor.find.case')}
        aria-pressed={caseSensitive}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleCase}
      >
        Aa
      </button>
      <span className="find-count" data-testid="find-count">{countLabel(matches.length, service.index)}</span>
      <button
        type="button"
        className="find-icon-button"
        data-testid="find-prev"
        aria-label={t('editor.find.previous')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => step(-1)}
      >
        <ChevronUp aria-hidden="true" size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="find-icon-button"
        data-testid="find-next"
        aria-label={t('editor.find.next')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => step(1)}
      >
        <ChevronDown aria-hidden="true" size={14} strokeWidth={1.75} />
      </button>
      <input
        className="replace-input"
        data-testid="replace-input"
        aria-label={t('editor.find.replaceWith')}
        placeholder={t('editor.find.replaceWith')}
        autoComplete="off"
        spellCheck={false}
        value={service.replacement}
        onChange={(event) => service.setReplacement(event.target.value)}
      />
      <button type="button" className="find-action" data-testid="replace-one" aria-label={t('editor.find.replace')} onMouseDown={(event) => event.preventDefault()} onClick={replaceCurrent}>
        {t('editor.find.replace')}
      </button>
      <button type="button" className="find-action" data-testid="replace-all" aria-label={t('editor.find.replaceAll')} onMouseDown={(event) => event.preventDefault()} onClick={replaceEvery}>
        {t('editor.find.replaceAll')}
      </button>
      <button type="button" className="find-icon-button" aria-label={t('editor.find.close')} onMouseDown={(event) => event.preventDefault()} onClick={() => service.close()}>
        <X aria-hidden="true" size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
})

export const EditorFind = bindServices(FindBar, [FindService])
