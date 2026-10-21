import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type WikilinkMenuItem =
  | { kind: 'note'; id: string; title: string }
  | { kind: 'create'; title: string }

export type WikilinkMenuHandle = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

export const WikilinkMenu = forwardRef<WikilinkMenuHandle, {
  items: WikilinkMenuItem[]
  command: (item: WikilinkMenuItem) => void
}>(function WikilinkMenu(props, ref) {
  const { t } = useTranslation()
  const itemsRef = useRef(props.items)
  const commandRef = useRef(props.command)
  const selectedRef = useRef(0)
  const [selected, setSelected] = useState(0)
  itemsRef.current = props.items
  commandRef.current = props.command
  const itemKey = props.items.map((item) => (item.kind === 'note' ? `n:${item.id}` : `c:${item.title}`)).join('\n')

  useEffect(() => {
    selectedRef.current = 0
    setSelected(0)
  }, [itemKey])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      const items = itemsRef.current
      if (event.key === 'ArrowDown') {
        if (items.length === 0) return false
        const next = (selectedRef.current + 1) % items.length
        selectedRef.current = next
        setSelected(next)
        return true
      }
      if (event.key === 'ArrowUp') {
        if (items.length === 0) return false
        const next = (selectedRef.current - 1 + items.length) % items.length
        selectedRef.current = next
        setSelected(next)
        return true
      }
      if (event.key === 'Enter') {
        const item = items[selectedRef.current]
        if (!item) return false
        commandRef.current(item)
        return true
      }
      if (event.key === 'Escape') return true
      return false
    },
  }), [])

  return (
    <div data-testid="wikilink-menu" className="wikilink-menu" role="listbox">
      {props.items.map((item, index) => (
        <button
          key={item.kind === 'note' ? item.id : 'create'}
          type="button"
          role="option"
          data-testid={item.kind === 'note' ? 'wikilink-item' : 'wikilink-create'}
          data-title={item.kind === 'note' ? item.title : undefined}
          aria-selected={index === selected}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.command(item)}
        >
          {item.kind === 'note' ? item.title : t('editor.create', { title: item.title })}
        </button>
      ))}
    </div>
  )
})
