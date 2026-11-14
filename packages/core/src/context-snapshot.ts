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
const OPEN_TAB_LIMIT = 20
const TRUNCATED_MARK = '\n…[truncated]'

interface ShownNoteText {
  text: string
  textChars: number
  textShownChars: number
  textTruncated: boolean
}

function shownNoteText(text: string): ShownNoteText {
  const textChars = text.length
  if (textChars <= NOTE_TEXT_LIMIT) {
    return { text, textChars, textShownChars: textChars, textTruncated: false }
  }
  return {
    text: `${text.slice(0, NOTE_TEXT_LIMIT)}${TRUNCATED_MARK}`,
    textChars,
    textShownChars: NOTE_TEXT_LIMIT,
    textTruncated: true,
  }
}

function truncationProse(lines: string[]): string {
  if (lines.length === 0) return ''
  return ` ${lines.join(' ')} This snapshot omits the rest. Use read_note, search_vault, or list_notes before answering from it.`
}

export function buildAgentContext(input: AgentContextInput): string {
  const activeNote = input.activeNote
    ? {
        id: input.activeNote.id,
        title: input.activeNote.title,
        type: input.activeNote.type,
        properties: { ...input.activeNote.properties },
        ...shownNoteText(input.activeNote.text),
      }
    : null
  const openTabs = input.openTabs.slice(0, OPEN_TAB_LIMIT).map((tab) => ({ id: tab.id, title: tab.title }))
  const tabsShown = openTabs.length
  const tabsTruncated = input.openTabs.length > OPEN_TAB_LIMIT
  const titles = input.vault.titles.slice(0, VAULT_TITLE_LIMIT)
  const titlesShown = titles.length
  const titlesTruncated = input.vault.noteCount > titlesShown || input.vault.titles.length > VAULT_TITLE_LIMIT
  const vault = {
    label: input.vault.label,
    noteCount: input.vault.noteCount,
    titles,
    titlesShown,
    titlesTruncated,
  }
  const omitted: string[] = []
  if (activeNote?.textTruncated) {
    omitted.push(`Active note text shows ${activeNote.textShownChars} of ${activeNote.textChars} characters.`)
  }
  if (titlesTruncated) omitted.push(`Vault titles show ${titlesShown} of ${input.vault.noteCount}.`)
  if (tabsTruncated) omitted.push(`Open tabs show ${tabsShown} of ${input.openTabs.length}.`)
  const prose = activeNote
    ? `Stride context snapshot. The open note is ${JSON.stringify(activeNote.title)}.${truncationProse(omitted)}`
    : `Stride context snapshot. No note is open.${truncationProse(omitted)}`
  return `${prose}\n\n${JSON.stringify({ activeNote, openTabs, tabsShown, tabsTruncated, vault }, null, 2)}\n`
}
