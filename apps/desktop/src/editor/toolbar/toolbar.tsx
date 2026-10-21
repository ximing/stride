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
import { useEffect, useRef, useState } from 'react'
import { formatShortcut } from '../../services/commands/commands'
import { applyLink, clearFormatting, runFormat, unsetLink, type FormatName } from '../extensions'
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
  label: string
  keys?: string
  icon: LucideIcon
  bubble: boolean
  active: string
  format?: FormatName
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
