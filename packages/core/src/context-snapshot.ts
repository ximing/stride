export interface AgentContextNote {
  id: string
  title: string
  type: string
  properties: Record<string, unknown>
  text: string
}

export interface AgentContextInput {
  activeNote: AgentContextNote | null
  openTabs: { id: string; title: string }[]
  vault: { label: string; noteCount: number; titles: string[] }
}

const NOTE_TEXT_LIMIT = 2000
const VAULT_TITLE_LIMIT = 40
const TRUNCATED_MARK = '\n…[truncated]'

function boundedNoteText(text: string): string {
  if (text.length <= NOTE_TEXT_LIMIT) return text
  return `${text.slice(0, NOTE_TEXT_LIMIT)}${TRUNCATED_MARK}`
}

export function buildAgentContext(input: AgentContextInput): string {
  const activeNote = input.activeNote
    ? {
        id: input.activeNote.id,
        title: input.activeNote.title,
        type: input.activeNote.type,
        properties: { ...input.activeNote.properties },
        text: boundedNoteText(input.activeNote.text),
      }
    : null
  const openTabs = input.openTabs.map((tab) => ({ id: tab.id, title: tab.title }))
  const vault = {
    label: input.vault.label,
    noteCount: input.vault.noteCount,
    titles: input.vault.titles.slice(0, VAULT_TITLE_LIMIT),
  }
  const prose = activeNote
    ? `Stride context snapshot. The open note is ${JSON.stringify(activeNote.title)}.`
    : 'Stride context snapshot. No note is open.'
  return `${prose}\n\n${JSON.stringify({ activeNote, openTabs, vault }, null, 2)}\n`
}
