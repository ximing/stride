import type { ReactNode } from 'react'

function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) nodes.push(text.slice(last, index))
    const token = match[0]
    if (token.startsWith('`')) nodes.push(<code key={`${key}-c-${index}`}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) nodes.push(<strong key={`${key}-b-${index}`}>{token.slice(2, -2)}</strong>)
    else {
      const linked = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token)
      if (linked?.[1] && linked[2]) nodes.push(<a key={`${key}-a-${index}`} href={linked[2]}>{linked[1]}</a>)
    }
    last = index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function blocks(source: string, key: string): ReactNode[] {
  const lines = source.split('\n')
  const nodes: ReactNode[] = []
  let list: string[] = []
  const flushList = () => {
    if (list.length === 0) return
    const items = list
    list = []
    nodes.push(
      <ul key={`${key}-ul-${nodes.length}`}>
        {items.map((item, index) => <li key={index}>{inline(item, `${key}-li-${index}`)}</li>)}
      </ul>,
    )
  }
  lines.forEach((line, index) => {
    const item = /^(?:[-*])\s+(.*)$/.exec(line)
    if (item?.[1] !== undefined) {
      list.push(item[1])
      return
    }
    flushList()
    if (!line.trim()) return
    nodes.push(<p key={`${key}-p-${index}`}>{inline(line, `${key}-p-${index}`)}</p>)
  })
  flushList()
  return nodes
}

export function ChatMarkdown({ text }: { text: string }) {
  const parts = text.split('```')
  return (
    <div className="chat-markdown">
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const code = part.replace(/^\w+\n/, '')
          return <pre key={index}><code>{code}</code></pre>
        }
        return <div key={index}>{blocks(part, String(index))}</div>
      })}
    </div>
  )
}
