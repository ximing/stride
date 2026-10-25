import type { Editor } from '@tiptap/core'
import type { FileSystemBackend } from '@stride/platform'
import {
  Bold,
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
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { t } from '../../i18n'
import { formatShortcut } from '../../services/commands/commands'
import { Tip } from '../../ui/primitives/tooltip'
import { applyLink, clearFormatting, runFormat, setMathPromptOpener, unsetLink, type FormatName } from '../extensions'
import { editorFindOpen, openEditorFind, subscribeEditorFind } from '../find/find-bar'
import { findSeedFromSelection } from '../find/find-hits'
import { insertStoredImages, storeImageFiles } from '../image/image'
import { insertMathLatex } from '../math/math'
import { insertMermaid } from '../mermaid/mermaid-insert'
import { EditorPrompt } from '../prompt'
import { ColorControl, EditorIcon } from './color-control'
import { BACKGROUND_COLORS, IDLE, TEXT_COLORS, barStateOf, keepSelection, type BarState } from './state'
import { iconSlot, sepSlot, TableActionBar } from './table-bar'
import { ToolSelect } from './tool-select'
import { OverflowToolbar, type OverflowSlot } from './toolbar-overflow'

type ToolSpec = {
  id: string
  keys?: string
  icon: LucideIcon
  bubble: boolean
  active: string
  format?: FormatName
}

export const editorTools: ToolSpec[] = [
  { id: 'bold', keys: 'Mod+B', icon: Bold, bubble: true, active: 'bold', format: 'bold' },
  { id: 'italic', keys: 'Mod+I', icon: Italic, bubble: true, active: 'italic', format: 'italic' },
  { id: 'h2', keys: 'Mod+Alt+2', icon: Heading2, bubble: false, active: 'h2', format: 'h2' },
  { id: 'h3', keys: 'Mod+Alt+3', icon: Heading3, bubble: false, active: 'h3', format: 'h3' },
  { id: 'bullet', keys: 'Mod+Shift+8', icon: List, bubble: false, active: 'bullet', format: 'bullet' },
  { id: 'ordered', keys: 'Mod+Shift+7', icon: ListOrdered, bubble: false, active: 'ordered', format: 'ordered' },
  { id: 'task', icon: ListTodo, bubble: false, active: 'task', format: 'task' },
  { id: 'quote', keys: 'Mod+Shift+B', icon: Quote, bubble: false, active: 'quote', format: 'quote' },
  { id: 'link', icon: LinkIcon, bubble: true, active: 'link' },
  { id: 'highlight', keys: 'Mod+Shift+H', icon: Highlighter, bubble: false, active: 'highlight', format: 'highlight' },
  { id: 'strike', keys: 'Mod+Shift+S', icon: Strikethrough, bubble: true, active: 'strike', format: 'strike' },
  { id: 'code', keys: 'Mod+E', icon: Code, bubble: false, active: 'code', format: 'code' },
  { id: 'code-block', icon: SquareCode, bubble: false, active: 'codeBlock', format: 'codeBlock' },
  { id: 'hr', icon: Minus, bubble: false, active: 'hr', format: 'hr' },
]

export function toolLabel(tool: ToolSpec, translate: (key: string) => string = t): string {
  const label = translate(`editor.tool.${tool.id}`)
  return tool.keys ? `${label} ${formatShortcut(tool.keys)}` : label
}

const HEADING_LEVELS = ['1', '2', '3', '4', '5', '6'] as const

const FONT_SIZE_VALUES = ['12px', '13px', '14px', '15px', '16px', '18px', '20px', '22px', '24px', '28px', '32px', '36px'] as const

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
    <Tip content={label}>
    <button
      type="button"
      className={pressed ? 'editor-tool is-active' : 'editor-tool'}
      data-testid={testId}
      aria-pressed={pressed || undefined}
      aria-label={label}
      disabled={disabled}
      onMouseDown={keepSelection}
      onClick={onClick}
    >
      <EditorIcon icon={icon} />
    </button>
    </Tip>
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
  const { t: translate } = useTranslation()
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => (current ? barStateOf(current) : IDLE),
  }) ?? IDLE
  const [styleMenu, setStyleMenu] = useState<null | 'color' | 'background' | 'cell'>(null)
  const [linkForm, setLinkForm] = useState<LinkForm | null>(null)
  const [linkSession, setLinkSession] = useState(0)
  const [mathOpen, setMathOpen] = useState(false)
  const findOpen = useSyncExternalStore(subscribeEditorFind, editorFindOpen, editorFindOpen)
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
    setMathPromptOpener(() => setMathOpen(true))
    return () => setMathPromptOpener(null)
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
    const seed = findSeedFromSelection(editor.state.doc, from, to) ?? ''
    openEditorFind(seed)
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
    return tool(spec.id, toolLabel(spec, translate), spec.icon, () => runTool(spec), { pressed })
  }

  const fontSizeOptions = [
    { value: '', label: translate('editor.defaultSize') },
    ...FONT_SIZE_VALUES.map((value) => ({ value, label: value.replace(/px$/, '') })),
  ]
  if (active.fontSize && !fontSizeOptions.some((item) => item.value === active.fontSize)) {
    fontSizeOptions.unshift({ value: active.fontSize, label: active.fontSize.replace(/px$/, '') })
  }
  const alignOptions = [
    { value: 'left', label: translate('editor.alignLeft') },
    { value: 'center', label: translate('editor.alignCenter') },
    { value: 'right', label: translate('editor.alignRight') },
  ]
  const headingOptions = [
    { value: 'p', label: translate('editor.text') },
    ...HEADING_LEVELS.map((level) => ({ value: level, label: `H${level}` })),
  ]
  const wikilinkLabel = translate('editor.wikilink')

  const slots: OverflowSlot[] = [
    tool('undo', translate('editor.tool.undo'), Undo2, () => editor.chain().focus().undo().run(), { disabled: !active.canUndo }),
    tool('redo', translate('editor.tool.redo'), Redo2, () => editor.chain().focus().redo().run(), { disabled: !active.canRedo }),
    sepSlot('sep-history'),
    known('bold')!,
    known('italic')!,
    known('strike')!,
    tool('subscript', translate('editor.tool.subscript'), Subscript, () => editor.chain().focus().toggleSubscript().run(), { pressed: active.subscript }),
    tool('superscript', translate('editor.tool.superscript'), Superscript, () => editor.chain().focus().toggleSuperscript().run(), { pressed: active.superscript }),
    {
      id: 'font-size',
      measure: 'select',
      node: (
        <ToolSelect
          testId="toolbar-font-size"
          label={translate('editor.fontSize')}
          value={active.fontSize}
          options={fontSizeOptions}
          onChange={(value) => applyFontSize(editor, value)}
        />
      ),
    },
    iconSlot('color', (
      <ColorControl
        testId="toolbar-color"
        label={translate('editor.fontColor')}
        clearLabel={translate('editor.restoreDefault')}
        icon={Palette}
        value={active.color}
        fallback="#221d16"
        colors={TEXT_COLORS}
        clearSwatch="#221d16"
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
        label={translate('editor.fontBackground')}
        clearLabel={translate('editor.none')}
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
    tool('clear', translate('editor.tool.clear'), Eraser, () => clearFormatting(editor)),
    sepSlot('sep-style'),
    {
      id: 'align',
      measure: 'select',
      node: (
        <ToolSelect
          testId="toolbar-align"
          label={translate('editor.align')}
          value={active.align}
          options={alignOptions}
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
          label={translate('editor.heading')}
          value={active.heading}
          options={headingOptions}
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
    tool('image', translate('editor.tool.image'), ImageIcon, () => imageInputRef.current?.click()),
    tool('table', translate('editor.tool.table'), TableIcon, () => {
      if (active.table) return
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    }, { pressed: active.table }),
    known('hr')!,
    tool('math', translate('editor.tool.math'), Sigma, () => setMathOpen(true)),
    tool('mermaid', translate('editor.slash.mermaid'), Workflow, () => insertMermaid(editor)),
    sepSlot('sep-find'),
    tool('find', translate('editor.tool.find'), Search, openFind, { pressed: findOpen }),
    sepSlot('sep-stride'),
    known('highlight')!,
    known('code')!,
    {
      id: 'wikilink',
      measure: { className: 'editor-tool editor-tool-text', text: wikilinkLabel },
      node: (
        <button
          type="button"
          className="editor-tool editor-tool-text"
          data-testid="toolbar-wikilink"
          aria-label={wikilinkLabel}
          onMouseDown={keepSelection}
          onClick={() => {
            setLinkForm(null)
            editor.chain().focus().insertContent('[[').run()
          }}
        >
          {wikilinkLabel}
        </button>
      ),
    },
  ]

  const bubble = editorTools.filter((item) => item.bubble)

  return (
    <>
      <div data-testid="editor-toolbar" className="editor-toolbar">
        <OverflowToolbar label={translate('editor.toolbar')} onClose={() => setStyleMenu((current) => (current === 'cell' ? current : null))} slots={slots} />
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
          title={translate('editor.linkTitle')}
          description={translate('editor.linkBody')}
          label={translate('editor.linkLabel')}
          initialValue={linkForm.href}
          placeholder={translate('editor.linkPlaceholder')}
          extraLabel={linkForm.hasLink ? translate('editor.unlink') : undefined}
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
          title={translate('editor.mathTitle')}
          description={translate('editor.mathBody')}
          label={translate('editor.mathLabel')}
          inputTestId="math-latex"
          initialValue=""
          placeholder={translate('editor.mathPlaceholder')}
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
            label={toolLabel(item, translate)}
            pressed={item.active === 'strike' ? active.strike : item.active === 'bold' ? active.bold : item.active === 'italic' ? active.italic : active.link}
            icon={item.icon}
            onClick={() => runTool(item)}
          />
        ))}
      </BubbleMenu>
    </>
  )
}
