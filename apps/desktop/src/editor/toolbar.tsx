import type { Editor } from '@tiptap/core'
import type { FileSystemBackend } from '@stride/platform'
import {
  Bold,
  Check,
  ChevronDown,
  Code,
  Eraser,
  Heading2,
  Heading3,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  PaintBucket,
  Palette,
  Quote,
  Redo2,
  Search,
  Sigma,
  SquareCode,
  Strikethrough,
  Subscript,
  Superscript,
  Table as TableIcon,
  Undo2,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { BubbleMenu } from '@tiptap/react/menus'
import { useEditorState } from '@tiptap/react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { formatShortcut } from '../services/commands'
import { applyLink, clearFormatting, runFormat, unsetLink, type FormatName } from './extensions'
import { findSeedFromSelection } from './find-hits'
import { insertStoredImages, storeImageFiles } from './image'
import { insertMathLatex } from './math'
import { insertMermaid } from './mermaid-insert'
import { EditorPrompt } from './prompt'
import {
  TABLE_CELL_COLORS,
  applyCellBackground,
  runTableCommand,
  tableActionState,
  tableShortcutLabel,
  type TableCommand,
  type TableShortcut,
} from './table-actions'
import { OverflowToolbar, type OverflowSlot } from './toolbar-overflow'

type ToolSpec = {
  id: string
  label: string
  keys?: string
  icon: LucideIcon
  bubble: boolean
  active: string
  format?: FormatName
}

function EditorIcon({ icon: Glyph }: { icon: LucideIcon }) {
  return <Glyph aria-hidden="true" size={16} strokeWidth={1.75} />
}

export const editorTools: ToolSpec[] = [
  { id: 'bold', label: '粗体', keys: 'Mod+B', icon: Bold, bubble: true, active: 'bold', format: 'bold' },
  { id: 'italic', label: '斜体', keys: 'Mod+I', icon: Italic, bubble: true, active: 'italic', format: 'italic' },
  { id: 'h2', label: 'H2', keys: 'Mod+Alt+2', icon: Heading2, bubble: false, active: 'h2', format: 'h2' },
  { id: 'h3', label: 'H3', keys: 'Mod+Alt+3', icon: Heading3, bubble: false, active: 'h3', format: 'h3' },
  { id: 'bullet', label: '无序列表', keys: 'Mod+Shift+8', icon: List, bubble: false, active: 'bullet', format: 'bullet' },
  { id: 'ordered', label: '有序列表', keys: 'Mod+Shift+7', icon: ListOrdered, bubble: false, active: 'ordered', format: 'ordered' },
  { id: 'task', label: '任务列表', icon: ListTodo, bubble: false, active: 'task', format: 'task' },
  { id: 'quote', label: '引用', keys: 'Mod+Shift+B', icon: Quote, bubble: false, active: 'quote', format: 'quote' },
  { id: 'link', label: '链接', icon: LinkIcon, bubble: true, active: 'link' },
  { id: 'highlight', label: '高亮', keys: 'Mod+Shift+H', icon: Highlighter, bubble: false, active: 'highlight', format: 'highlight' },
  { id: 'strike', label: '删除线', keys: 'Mod+Shift+S', icon: Strikethrough, bubble: true, active: 'strike', format: 'strike' },
  { id: 'code', label: '行内代码', keys: 'Mod+E', icon: Code, bubble: false, active: 'code', format: 'code' },
  { id: 'code-block', label: '代码块', icon: SquareCode, bubble: false, active: 'codeBlock', format: 'codeBlock' },
  { id: 'hr', label: '分隔线', icon: Minus, bubble: false, active: 'hr', format: 'hr' },
]

export function toolLabel(tool: ToolSpec): string {
  return tool.keys ? `${tool.label} ${formatShortcut(tool.keys)}` : tool.label
}

const HEADING_OPTIONS = [
  { value: 'p', label: '正文' },
  { value: '1', label: 'H1' },
  { value: '2', label: 'H2' },
  { value: '3', label: 'H3' },
  { value: '4', label: 'H4' },
  { value: '5', label: 'H5' },
  { value: '6', label: 'H6' },
]

const ALIGN_OPTIONS = [
  { value: 'left', label: '居左' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '居右' },
]

const FONT_SIZE_OPTIONS = [
  { value: '', label: '默认' },
  { value: '12px', label: '12' },
  { value: '13px', label: '13' },
  { value: '14px', label: '14' },
  { value: '15px', label: '15' },
  { value: '16px', label: '16' },
  { value: '18px', label: '18' },
  { value: '20px', label: '20' },
  { value: '22px', label: '22' },
  { value: '24px', label: '24' },
  { value: '28px', label: '28' },
  { value: '32px', label: '32' },
  { value: '36px', label: '36' },
]

const TEXT_COLORS = [
  { label: '赤', value: '#b3402a' },
  { label: '赭', value: '#9a6232' },
  { label: '绿', value: '#2f7d4a' },
  { label: '蓝', value: '#2a5f9e' },
  { label: '紫', value: '#6a4c93' },
  { label: '墨', value: '#221d16' },
  { label: '灰', value: '#6f675c' },
] as const

const BACKGROUND_COLORS = [
  { label: '黄', value: '#f6e7a8' },
  { label: '绿', value: '#d7efd4' },
  { label: '蓝', value: '#d6e6f7' },
  { label: '粉', value: '#f8d6d0' },
  { label: '紫', value: '#e7dff6' },
  { label: '灰', value: '#ece7df' },
] as const

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

type BarState = {
  bold: boolean
  italic: boolean
  strike: boolean
  subscript: boolean
  superscript: boolean
  bullet: boolean
  ordered: boolean
  task: boolean
  quote: boolean
  link: boolean
  highlight: boolean
  code: boolean
  codeBlock: boolean
  table: boolean
  canUndo: boolean
  canRedo: boolean
  heading: string
  align: 'left' | 'center' | 'right'
  fontSize: string
  color: string
  background: string
}

const IDLE: BarState = {
  bold: false,
  italic: false,
  strike: false,
  subscript: false,
  superscript: false,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  link: false,
  highlight: false,
  code: false,
  codeBlock: false,
  table: false,
  canUndo: false,
  canRedo: false,
  heading: 'p',
  align: 'left',
  fontSize: '',
  color: '',
  background: '',
}

function styleAttr(editor: Editor, key: 'color' | 'fontSize' | 'backgroundColor'): string {
  const value = editor.getAttributes('textStyle')[key]
  return typeof value === 'string' ? value : ''
}

function barStateOf(editor: Editor): BarState {
  let heading = 'p'
  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    if (editor.isActive('heading', { level })) heading = String(level)
  }
  const align = editor.isActive({ textAlign: 'center' })
    ? 'center'
    : editor.isActive({ textAlign: 'right' })
      ? 'right'
      : 'left'
  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    strike: editor.isActive('strike'),
    subscript: editor.isActive('subscript'),
    superscript: editor.isActive('superscript'),
    bullet: editor.isActive('bulletList'),
    ordered: editor.isActive('orderedList'),
    task: editor.isActive('taskList'),
    quote: editor.isActive('blockquote'),
    link: editor.isActive('link'),
    highlight: editor.isActive('highlight'),
    code: editor.isActive('code'),
    codeBlock: editor.isActive('codeBlock'),
    table: editor.isActive('table'),
    canUndo: editor.can().chain().undo().run(),
    canRedo: editor.can().chain().redo().run(),
    heading,
    align,
    fontSize: styleAttr(editor, 'fontSize'),
    color: styleAttr(editor, 'color'),
    background: styleAttr(editor, 'backgroundColor'),
  }
}

function keepSelection(event: { preventDefault: () => void }) {
  event.preventDefault()
}

const MENU_TABBABLE =
  'a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)'

function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(MENU_TABBABLE)).filter((element) => {
    if (element.closest('.select-menu')) return false
    if (element.tabIndex < 0) return false
    return true
  })
}

/** Tab from an open menu moves focus the way a native menu would. */
function focusAfterMenuTab(trigger: HTMLButtonElement, shift: boolean): void {
  const dialog = trigger.closest<HTMLElement>('[role="dialog"], dialog')
  const elements = tabbables(dialog ?? document.body)
  const index = elements.indexOf(trigger)
  if (index < 0) {
    trigger.focus({ preventScroll: true })
    return
  }
  const nextIndex = shift ? index - 1 : index + 1
  if (!dialog) {
    ;(elements[nextIndex] ?? trigger).focus({ preventScroll: true })
    return
  }
  const wrapped =
    nextIndex < 0 ? elements[elements.length - 1] : nextIndex >= elements.length ? elements[0] : elements[nextIndex]
  ;(wrapped ?? trigger).focus({ preventScroll: true })
}

function applyHeading(editor: Editor, value: string) {
  const chain = editor.chain().focus()
  if (value === 'p') {
    chain.setParagraph().run()
    return
  }
  const level = Number(value)
  if (level < 1 || level > 6) return
  chain.setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run()
}

function applyFontSize(editor: Editor, value: string) {
  const chain = editor.chain().focus()
  if (!value) chain.unsetFontSize().run()
  else chain.setFontSize(value).run()
}

function applyAlign(editor: Editor, value: string) {
  if (value === 'left') editor.chain().focus().unsetTextAlign().run()
  else if (value === 'center' || value === 'right') editor.chain().focus().setTextAlign(value).run()
}

type LinkForm = { href: string; from: number; to: number; hasLink: boolean }

function ToolButton({
  testId,
  label,
  pressed,
  disabled,
  icon,
  onClick,
}: {
  testId: string
  label: string
  pressed?: boolean
  disabled?: boolean
  icon: LucideIcon
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={pressed ? 'editor-tool is-active' : 'editor-tool'}
      data-testid={testId}
      aria-pressed={pressed || undefined}
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={keepSelection}
      onClick={onClick}
    >
      <EditorIcon icon={icon} />
    </button>
  )
}

function iconSlot(id: string, node: ReactNode, active = false): OverflowSlot {
  return { id, node, active }
}

function sepSlot(id: string): OverflowSlot {
  return { id, separator: true, node: <span className="editor-tool-sep" /> }
}

function ToolSelect({
  testId,
  label,
  value,
  options,
  onChange,
}: {
  testId: string
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const listId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined

  function openAt(index: number) {
    if (options.length === 0) return
    const clamped = Math.min(Math.max(index, 0), options.length - 1)
    setActiveIndex(clamped)
    setOpen(true)
  }

  function choose(next: string) {
    if (next !== value) onChange(next)
    setOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const anchor = buttonRef.current
      const menu = menuRef.current
      if (!anchor || !menu) return
      const rect = anchor.getBoundingClientRect()
      let left = rect.left
      let top = rect.bottom + 6
      const width = menu.offsetWidth
      const height = menu.offsetHeight
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8)
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6)
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.focus({ preventScroll: true })
  }, [open, activeIndex])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus({ preventScroll: true })
        return
      }
      if (event.key !== 'Tab') return
      const trigger = buttonRef.current
      if (!trigger) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      focusAfterMenuTab(trigger, event.shiftKey)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`editor-tool-select${open ? ' is-open' : ''}`}
        data-testid={testId}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onMouseDown={(event) => {
          event.preventDefault()
          if (open) setOpen(false)
          else openAt(selectedIndex >= 0 ? selectedIndex : 0)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openAt(selectedIndex >= 0 ? selectedIndex : event.key === 'ArrowUp' ? options.length - 1 : 0)
        }}
      >
        <span>{current?.label ?? label}</span>
        <ChevronDown aria-hidden="true" size={14} strokeWidth={1.75} />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              className="select-menu editor-select-menu"
              role="listbox"
              aria-label={label}
              style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {options.map((option, index) => (
                <button
                  key={option.value || 'default'}
                  ref={(node) => {
                    optionRefs.current[index] = node
                  }}
                  type="button"
                  role="option"
                  data-value={option.value}
                  aria-selected={option.value === value}
                  className={[option.value === value ? 'is-on' : '', index === activeIndex ? 'is-active' : '']
                    .filter(Boolean)
                    .join(' ') || undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(option.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setActiveIndex((currentIndex) => (currentIndex + 1) % options.length)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setActiveIndex((currentIndex) => (currentIndex - 1 + options.length) % options.length)
                    } else if (event.key === 'Home') {
                      event.preventDefault()
                      setActiveIndex(0)
                    } else if (event.key === 'End') {
                      event.preventDefault()
                      setActiveIndex(options.length - 1)
                    }
                  }}
                >
                  <span className="editor-select-option-check" aria-hidden="true">
                    {option.value === value ? <Check size={14} strokeWidth={1.75} /> : null}
                  </span>
                  <span>{option.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function ColorControl({
  testId,
  label,
  clearLabel,
  icon,
  value,
  fallback,
  colors,
  open,
  pressed,
  onOpenChange,
  onPick,
}: {
  testId: string
  label: string
  clearLabel: string
  icon: LucideIcon
  value: string
  fallback: string
  colors: readonly { label: string; value: string }[]
  open: boolean
  pressed?: boolean
  onOpenChange: (open: boolean) => void
  onPick: (value: string | null) => void
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const shown = HEX_COLOR.test(value) ? value : fallback

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const anchor = buttonRef.current
      const pop = popRef.current
      if (!anchor || !pop) return
      const rect = anchor.getBoundingClientRect()
      const width = pop.offsetWidth
      const height = pop.offsetHeight
      let left = rect.left
      let top = rect.bottom + 6
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8)
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6)
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      onOpenChange(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onOpenChange(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [onOpenChange, open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`editor-tool editor-color-tool${open || pressed ? ' is-active' : ''}`}
        data-testid={testId}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-pressed={pressed || undefined}
        onMouseDown={(event) => {
          event.preventDefault()
          onOpenChange(!open)
        }}
      >
        <EditorIcon icon={icon} />
        <span className={value ? 'editor-color-bar' : 'editor-color-bar is-empty'} style={value ? { background: value } : undefined} />
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="editor-color-pop"
              role="dialog"
              aria-label={label}
              style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
              onMouseDown={(event) => {
                if (event.target instanceof HTMLInputElement) return
                event.preventDefault()
              }}
            >
              <div className="editor-color-swatches">
                {colors.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    className={`editor-color-swatch${value.toLowerCase() === color.value ? ' is-on' : ''}`}
                    style={{ background: color.value }}
                    aria-label={color.label}
                    aria-pressed={value.toLowerCase() === color.value}
                    onClick={() => {
                      onPick(color.value)
                      onOpenChange(false)
                    }}
                  />
                ))}
              </div>
              <label className="editor-color-custom">
                自定义
                <input
                  type="color"
                  aria-label={`${label}自定义`}
                  value={shown}
                  onChange={(event) => onPick(event.target.value)}
                />
              </label>
              <button
                type="button"
                className={value ? 'editor-color-clear' : 'editor-color-clear is-on'}
                onClick={() => {
                  onPick(null)
                  onOpenChange(false)
                }}
              >
                {clearLabel}
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function TableActionBar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => (instance ? tableActionState(instance) : null),
  })
  const [cellColorOpen, setCellColorOpen] = useState(false)
  if (!state) return null
  const action = (label: string, command: TableCommand, extra?: { disabled?: boolean; pressed?: boolean }) => {
    const shortcut: TableShortcut | null =
      command === 'addRowBefore' ||
      command === 'addRowAfter' ||
      command === 'addColumnBefore' ||
      command === 'addColumnAfter' ||
      command === 'deleteRow' ||
      command === 'deleteColumn'
        ? command
        : null
    const hint = shortcut ? tableShortcutLabel(shortcut) : undefined
    return {
      id: command,
      active: extra?.pressed,
      measure: { className: 'editor-tool is-wide', text: label },
      node: (
        <button
          type="button"
          className={`editor-tool is-wide${extra?.pressed ? ' is-active' : ''}`}
          data-testid={`table-${command}`}
          aria-label={label}
          title={hint ? `${label}（${hint}）` : label}
          aria-pressed={extra?.pressed}
          disabled={extra?.disabled}
          onMouseDown={keepSelection}
          onClick={() => runTableCommand(editor, command)}
        >
          {label}
        </button>
      ),
    } satisfies OverflowSlot
  }
  return (
    <OverflowToolbar
      label="表格操作"
      className="editor-table-bar"
      slots={[
        { id: 'label', measure: { className: 'editor-table-label', text: '表格' }, node: <span className="editor-table-label">表格</span> },
        action('上方加行', 'addRowBefore'),
        action('下方加行', 'addRowAfter'),
        action('删除行', 'deleteRow', { disabled: !state.canDeleteRow }),
        sepSlot('sep-row'),
        action('左侧加列', 'addColumnBefore'),
        action('右侧加列', 'addColumnAfter'),
        action('删除列', 'deleteColumn', { disabled: !state.canDeleteColumn }),
        sepSlot('sep-col'),
        action('合并单元格', 'mergeCells', { disabled: !state.canMerge }),
        action('拆分单元格', 'splitCell', { disabled: !state.canSplit }),
        sepSlot('sep-cell'),
        action('表头行', 'toggleHeaderRow', { pressed: state.headerRow }),
        action('表头列', 'toggleHeaderColumn', { pressed: state.headerColumn }),
        iconSlot('cell-color', (
          <ColorControl
            testId="table-cell-color"
            label="单元格背景"
            clearLabel="无"
            icon={PaintBucket}
            value={state.background}
            fallback="#ece7df"
            colors={TABLE_CELL_COLORS}
            open={cellColorOpen}
            pressed={state.background !== ''}
            onOpenChange={setCellColorOpen}
            onPick={(value) => applyCellBackground(editor, value)}
          />
        ), state.background !== ''),
        sepSlot('sep-delete'),
        action('删除表格', 'deleteTable'),
      ]}
    />
  )
}

export function EditorToolbar({
  editor,
  openLinkRef,
  getFs,
}: {
  editor: Editor
  openLinkRef: { current: () => boolean }
  getFs?: () => FileSystemBackend | null
}) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => (current ? barStateOf(current) : IDLE),
  }) ?? IDLE
  const [styleMenu, setStyleMenu] = useState<null | 'color' | 'background' | 'cell'>(null)
  const [linkForm, setLinkForm] = useState<LinkForm | null>(null)
  const [linkSession, setLinkSession] = useState(0)
  const [mathOpen, setMathOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)

  openLinkRef.current = () => {
    const { from, to } = editor.state.selection
    const linked = editor.isActive('link')
    const raw = editor.getAttributes('link').href
    setLinkForm({
      href: linked && typeof raw === 'string' ? raw : '',
      from,
      to,
      hasLink: linked,
    })
    setLinkSession((session) => session + 1)
    return true
  }

  useEffect(() => {
    const onMath = () => setMathOpen(true)
    const onFind = (event: Event) => {
      const open = Boolean((event as CustomEvent<{ open?: boolean }>).detail?.open)
      setFindOpen(open)
    }
    window.addEventListener('stride-editor-math', onMath)
    window.addEventListener('stride-editor-find-open', onFind)
    return () => {
      window.removeEventListener('stride-editor-math', onMath)
      window.removeEventListener('stride-editor-find-open', onFind)
    }
  }, [])

  function runTool(tool: ToolSpec) {
    if (tool.id === 'link') {
      openLinkRef.current()
      return
    }
    if (tool.format) runFormat(editor, tool.format)
  }

  function openFind() {
    const { from, to } = editor.state.selection
    const seed = findSeedFromSelection(editor.state.doc, from, to)
    window.dispatchEvent(new CustomEvent('stride-editor-find', { detail: { seed } }))
  }

  const tool = (id: string, label: string, icon: LucideIcon, onClick: () => void, extra?: { pressed?: boolean; disabled?: boolean }) =>
    iconSlot(id, (
      <ToolButton
        testId={`toolbar-${id}`}
        label={label}
        icon={icon}
        pressed={extra?.pressed}
        disabled={extra?.disabled}
        onClick={onClick}
      />
    ), extra?.pressed)

  const known = (id: string) => {
    const spec = editorTools.find((item) => item.id === id)
    if (!spec) return null
    const pressed = spec.active === 'h2'
      ? active.heading === '2'
      : spec.active === 'h3'
        ? active.heading === '3'
        : Boolean(active[spec.active as keyof BarState])
    return tool(spec.id, toolLabel(spec), spec.icon, () => runTool(spec), { pressed })
  }

  const slots: OverflowSlot[] = [
    tool('undo', '撤销', Undo2, () => editor.chain().focus().undo().run(), { disabled: !active.canUndo }),
    tool('redo', '重做', Redo2, () => editor.chain().focus().redo().run(), { disabled: !active.canRedo }),
    sepSlot('sep-history'),
    known('bold')!,
    known('italic')!,
    known('strike')!,
    tool('subscript', '下标', Subscript, () => editor.chain().focus().toggleSubscript().run(), { pressed: active.subscript }),
    tool('superscript', '上标', Superscript, () => editor.chain().focus().toggleSuperscript().run(), { pressed: active.superscript }),
    {
      id: 'font-size',
      measure: 'select',
      node: (
        <ToolSelect
          testId="toolbar-font-size"
          label="字号"
          value={active.fontSize}
          options={
            active.fontSize && !FONT_SIZE_OPTIONS.some((item) => item.value === active.fontSize)
              ? [{ value: active.fontSize, label: active.fontSize.replace(/px$/, '') }, ...FONT_SIZE_OPTIONS]
              : FONT_SIZE_OPTIONS
          }
          onChange={(value) => applyFontSize(editor, value)}
        />
      ),
    },
    iconSlot('color', (
      <ColorControl
        testId="toolbar-color"
        label="字体颜色"
        clearLabel="默认"
        icon={Palette}
        value={active.color}
        fallback="#221d16"
        colors={TEXT_COLORS}
        open={styleMenu === 'color'}
        pressed={active.color !== ''}
        onOpenChange={(open) => setStyleMenu(open ? 'color' : null)}
        onPick={(value) => {
          if (!value) editor.chain().focus().unsetColor().run()
          else editor.chain().focus().setColor(value).run()
        }}
      />
    ), active.color !== ''),
    iconSlot('background', (
      <ColorControl
        testId="toolbar-background"
        label="字体背景色"
        clearLabel="无"
        icon={Highlighter}
        value={active.background}
        fallback="#f6e7a8"
        colors={BACKGROUND_COLORS}
        open={styleMenu === 'background'}
        pressed={active.background !== ''}
        onOpenChange={(open) => setStyleMenu(open ? 'background' : null)}
        onPick={(value) => {
          if (!value) editor.chain().focus().unsetBackgroundColor().run()
          else editor.chain().focus().setBackgroundColor(value).run()
        }}
      />
    ), active.background !== ''),
    tool('clear', '清除格式', Eraser, () => clearFormatting(editor)),
    sepSlot('sep-style'),
    {
      id: 'align',
      measure: 'select',
      node: (
        <ToolSelect
          testId="toolbar-align"
          label="对齐"
          value={active.align}
          options={ALIGN_OPTIONS}
          onChange={(value) => applyAlign(editor, value)}
        />
      ),
    },
    {
      id: 'heading',
      measure: 'select',
      node: (
        <ToolSelect
          testId="toolbar-heading"
          label="标题"
          value={active.heading}
          options={HEADING_OPTIONS}
          onChange={(value) => applyHeading(editor, value)}
        />
      ),
    },
    known('quote')!,
    sepSlot('sep-block'),
    known('bullet')!,
    known('ordered')!,
    known('task')!,
    known('code-block')!,
    sepSlot('sep-insert'),
    known('link')!,
    tool('image', '图片', ImageIcon, () => imageInputRef.current?.click()),
    tool('table', '表格', TableIcon, () => {
      if (active.table) return
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    }, { pressed: active.table }),
    known('hr')!,
    tool('math', '公式', Sigma, () => setMathOpen(true)),
    tool('mermaid', 'Mermaid', Workflow, () => insertMermaid(editor)),
    sepSlot('sep-find'),
    tool('find', '查找', Search, openFind, { pressed: findOpen }),
    sepSlot('sep-stride'),
    known('highlight')!,
    known('code')!,
    {
      id: 'wikilink',
      measure: { className: 'editor-tool editor-tool-text', text: 'Wikilink' },
      node: (
        <button
          type="button"
          className="editor-tool editor-tool-text"
          data-testid="toolbar-wikilink"
          aria-label="Wikilink"
          onMouseDown={keepSelection}
          onClick={() => {
            setLinkForm(null)
            editor.chain().focus().insertContent('[[').run()
          }}
        >
          Wikilink
        </button>
      ),
    },
  ]

  const bubble = editorTools.filter((item) => item.bubble)

  return (
    <>
      <div data-testid="editor-toolbar" className="editor-toolbar">
        <OverflowToolbar label="编辑器工具栏" onClose={() => setStyleMenu((current) => (current === 'cell' ? current : null))} slots={slots} />
        {active.table ? <TableActionBar editor={editor} /> : null}
      </div>
      <input
        ref={imageInputRef}
        data-testid="toolbar-image-input"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          const fs = getFs?.() ?? null
          if (!fs || files.length === 0) return
          const { from, to } = editor.state.selection
          void storeImageFiles(fs, files).then((srcs) => insertStoredImages(editor, srcs, from, to))
        }}
      />
      {linkForm ? (
        <EditorPrompt
          key={linkSession}
          title="链接"
          description="输入链接地址。选区为空时，地址会作为链接文字插入。"
          label="链接地址"
          initialValue={linkForm.href}
          placeholder="https://"
          extraLabel={linkForm.hasLink ? '取消链接' : undefined}
          onSubmit={(value) => {
            editor.commands.setTextSelection({ from: linkForm.from, to: linkForm.to })
            if (!value.trim()) {
              if (linkForm.hasLink) unsetLink(editor)
              setLinkForm(null)
              return
            }
            if (applyLink(editor, value)) setLinkForm(null)
          }}
          onExtra={() => {
            editor.commands.setTextSelection({ from: linkForm.from, to: linkForm.to })
            unsetLink(editor)
            setLinkForm(null)
          }}
          onClose={() => setLinkForm(null)}
        />
      ) : null}
      {mathOpen ? (
        <EditorPrompt
          title="公式"
          description="行内公式用 $...$，独立公式用 $$...$$。"
          label="LaTeX"
          inputTestId="math-latex"
          initialValue=""
          placeholder="$E=mc^2$"
          onSubmit={(value) => {
            if (value.trim()) insertMathLatex(editor, value)
            setMathOpen(false)
          }}
          onClose={() => setMathOpen(false)}
        />
      ) : null}
      <BubbleMenu
        editor={editor}
        className="editor-bubble"
        data-testid="editor-bubble"
        updateDelay={0}
        options={{
          placement: 'top',
          offset: 8,
          flip: {
            boundary: editor.view.dom,
            fallbackPlacements: ['bottom'],
            padding: 8,
          },
          shift: {
            boundary: editor.view.dom.closest('.stage') ?? editor.view.dom,
            padding: 8,
          },
        }}
        shouldShow={({ editor: current, state }) => {
          if (!current.isEditable) return false
          const { from, to, empty } = state.selection
          if (empty) return false
          return state.doc.textBetween(from, to).length > 0
        }}
      >
        {bubble.map((item) => (
          <ToolButton
            key={item.id}
            testId={`bubble-${item.id}`}
            label={toolLabel(item)}
            pressed={item.active === 'strike' ? active.strike : item.active === 'bold' ? active.bold : item.active === 'italic' ? active.italic : active.link}
            icon={item.icon}
            onClick={() => runTool(item)}
          />
        ))}
      </BubbleMenu>
    </>
  )
}
