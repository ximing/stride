import type { Editor } from '@tiptap/core'
import type { Icon } from '@phosphor-icons/react'
import {
  CheckSquare,
  Code,
  CodeBlock,
  Highlighter,
  Link as LinkIcon,
  ListBullets,
  ListNumbers,
  Minus,
  Quotes,
  TextB,
  TextHThree,
  TextHTwo,
  TextItalic,
  TextStrikethrough,
} from '@phosphor-icons/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { useEditorState } from '@tiptap/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Mark } from '../ui/icon'
import { applyLink, runFormat, unsetLink, type FormatName } from './extensions'
import { addTableColumn, addTableRow, deleteTableColumn, deleteTableRow } from './table'

type ActiveKey =
  | 'bold'
  | 'italic'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'quote'
  | 'link'
  | 'highlight'
  | 'strike'
  | 'code'
  | 'codeBlock'
  | 'hr'
  | 'table'

type ActiveState = Record<ActiveKey, boolean>

type ToolSpec = {
  id: string
  label: string
  icon: Icon
  bubble: boolean
  active: ActiveKey
  format?: FormatName
}

const IDLE: ActiveState = {
  bold: false,
  italic: false,
  h2: false,
  h3: false,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  link: false,
  highlight: false,
  strike: false,
  code: false,
  codeBlock: false,
  hr: false,
  table: false,
}

export const editorTools: ToolSpec[] = [
  { id: 'bold', label: '粗体 ⌘B', icon: TextB, bubble: true, active: 'bold', format: 'bold' },
  { id: 'italic', label: '斜体 ⌘I', icon: TextItalic, bubble: true, active: 'italic', format: 'italic' },
  { id: 'h2', label: 'H2 ⌘⌥2', icon: TextHTwo, bubble: true, active: 'h2', format: 'h2' },
  { id: 'h3', label: 'H3 ⌘⌥3', icon: TextHThree, bubble: true, active: 'h3', format: 'h3' },
  { id: 'bullet', label: '无序列表 ⌘⇧8', icon: ListBullets, bubble: true, active: 'bullet', format: 'bullet' },
  { id: 'ordered', label: '有序列表 ⌘⇧7', icon: ListNumbers, bubble: true, active: 'ordered', format: 'ordered' },
  { id: 'task', label: '任务列表', icon: CheckSquare, bubble: false, active: 'task', format: 'task' },
  { id: 'quote', label: '引用 ⌘⇧B', icon: Quotes, bubble: true, active: 'quote', format: 'quote' },
  { id: 'link', label: '链接 ⌘K', icon: LinkIcon, bubble: true, active: 'link' },
  { id: 'highlight', label: '高亮 ⌘⇧H', icon: Highlighter, bubble: true, active: 'highlight', format: 'highlight' },
  { id: 'strike', label: '删除线 ⌘⇧S', icon: TextStrikethrough, bubble: false, active: 'strike', format: 'strike' },
  { id: 'code', label: '行内代码 ⌘E', icon: Code, bubble: false, active: 'code', format: 'code' },
  { id: 'code-block', label: '代码块', icon: CodeBlock, bubble: false, active: 'codeBlock', format: 'codeBlock' },
  { id: 'hr', label: '分隔线', icon: Minus, bubble: false, active: 'hr', format: 'hr' },
]

type LinkForm = {
  href: string
  from: number
  to: number
}

function keepSelection(event: { preventDefault: () => void }) {
  event.preventDefault()
}

function ToolButton({
  testId,
  label,
  pressed,
  icon,
  onClick,
}: {
  testId: string
  label: string
  pressed: boolean
  icon: Icon
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={pressed ? 'editor-tool is-active' : 'editor-tool'}
      data-testid={testId}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onMouseDown={keepSelection}
      onClick={onClick}
    >
      <Mark icon={icon} />
    </button>
  )
}

export function EditorToolbar({
  editor,
  openLinkRef,
}: {
  editor: Editor
  openLinkRef: { current: () => boolean }
}) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return IDLE
      return {
        bold: current.isActive('bold'),
        italic: current.isActive('italic'),
        h2: current.isActive('heading', { level: 2 }),
        h3: current.isActive('heading', { level: 3 }),
        bullet: current.isActive('bulletList'),
        ordered: current.isActive('orderedList'),
        task: current.isActive('taskList'),
        quote: current.isActive('blockquote'),
        link: current.isActive('link'),
        highlight: current.isActive('highlight'),
        strike: current.isActive('strike'),
        code: current.isActive('code'),
        codeBlock: current.isActive('codeBlock'),
        hr: current.isActive('horizontalRule'),
        table: current.isActive('table'),
      }
    },
  }) ?? IDLE

  const [linkForm, setLinkForm] = useState<LinkForm | null>(null)
  const [linkSession, setLinkSession] = useState(0)
  const hrefRef = useRef<HTMLInputElement>(null)

  openLinkRef.current = () => {
    const { from, to } = editor.state.selection
    const linked = editor.isActive('link')
    const raw = editor.getAttributes('link').href
    setLinkForm({
      href: linked && typeof raw === 'string' ? raw : '',
      from,
      to,
    })
    setLinkSession((session) => session + 1)
    return true
  }

  useEffect(() => {
    if (linkSession === 0) return
    hrefRef.current?.focus()
  }, [linkSession])

  function runTool(tool: ToolSpec) {
    if (tool.id === 'link') {
      openLinkRef.current()
      return
    }
    if (tool.format) runFormat(editor, tool.format)
  }

  function submitLink(event: FormEvent) {
    event.preventDefault()
    if (!linkForm) return
    editor.commands.setTextSelection({ from: linkForm.from, to: linkForm.to })
    if (applyLink(editor, linkForm.href)) setLinkForm(null)
  }

  function removeLink() {
    if (!linkForm) return
    editor.commands.setTextSelection({ from: linkForm.from, to: linkForm.to })
    unsetLink(editor)
    setLinkForm(null)
  }

  const bubbleTools = editorTools.filter((tool) => tool.bubble)

  return (
    <>
      <div data-testid="editor-toolbar" className="editor-toolbar" role="toolbar" aria-label="编辑器工具栏">
        {editorTools.map((tool) => (
          <ToolButton
            key={tool.id}
            testId={`toolbar-${tool.id}`}
            label={tool.label}
            pressed={active[tool.active]}
            icon={tool.icon}
            onClick={() => runTool(tool)}
          />
        ))}
        <button
          type="button"
          className="editor-tool editor-tool-text"
          data-testid="toolbar-wikilink"
          aria-label="Wikilink"
          onMouseDown={keepSelection}
          onClick={() => {
            setLinkForm(null)
            editor.chain().insertContent('[[').run()
          }}
        >
          Wikilink
        </button>
        {active.table && (
          <>
            <button
              type="button"
              className="editor-tool editor-tool-text"
              data-testid="table-add-row"
              aria-label="添加行"
              onMouseDown={keepSelection}
              onClick={() => addTableRow(editor)}
            >
              添加行
            </button>
            <button
              type="button"
              className="editor-tool editor-tool-text"
              data-testid="table-del-row"
              aria-label="删除行"
              onMouseDown={keepSelection}
              onClick={() => deleteTableRow(editor)}
            >
              删除行
            </button>
            <button
              type="button"
              className="editor-tool editor-tool-text"
              data-testid="table-add-column"
              aria-label="添加列"
              onMouseDown={keepSelection}
              onClick={() => addTableColumn(editor)}
            >
              添加列
            </button>
            <button
              type="button"
              className="editor-tool editor-tool-text"
              data-testid="table-del-column"
              aria-label="删除列"
              onMouseDown={keepSelection}
              onClick={() => deleteTableColumn(editor)}
            >
              删除列
            </button>
          </>
        )}
        {linkForm && (
          <form className="wikilink-draft" onSubmit={submitLink}>
            <input
              ref={hrefRef}
              data-testid="link-href"
              aria-label="链接地址"
              value={linkForm.href}
              placeholder="https://"
              autoComplete="off"
              onChange={(event) => setLinkForm({ ...linkForm, href: event.target.value })}
            />
            <button type="submit">应用</button>
            <button type="button" data-testid="link-unset" onMouseDown={keepSelection} onClick={removeLink}>
              移除链接
            </button>
            <button type="button" onClick={() => setLinkForm(null)}>取消</button>
          </form>
        )}
      </div>
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
        {bubbleTools.map((tool) => (
          <ToolButton
            key={tool.id}
            testId={`bubble-${tool.id}`}
            label={tool.label}
            pressed={active[tool.active]}
            icon={tool.icon}
            onClick={() => runTool(tool)}
          />
        ))}
      </BubbleMenu>
    </>
  )
}
