import {
  BookOpen,
  Check,
  FileText,
  Folder,
  GitBranch,
  Home,
  Inbox,
  MessageCircle,
  Notebook,
  Search,
} from 'lucide-react'
import { observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import { ComponentsPreviewService } from '../primitives/preview.service'

type SampleNote = {
  id: string
  title: string
  when: string
  snippet: string
  type: string
  status: string
  place: string
  paragraphs: string[]
  linkId?: string
  linkLead?: string
  backlinks: string[]
}

const notes: SampleNote[] = [
  {
    id: 'moss',
    title: 'Moss on the north wall',
    when: 'Today',
    snippet: 'The bricks stay damp until noon.',
    type: 'Journal',
    status: 'Growing',
    place: 'North wall',
    paragraphs: [
      'The moss is thicker where the tap drips. I pressed a thumb into it and the print stayed, darker than the rest, until the sun cleared the fence.',
    ],
    linkId: 'walks',
    linkLead: 'Kept with',
    backlinks: ['walks'],
  },
  {
    id: 'path',
    title: 'What the garden path remembers',
    when: 'Yesterday',
    snippet: 'Gravel sunk on the left, rosemary leaning in.',
    type: 'Journal',
    status: 'Filed',
    place: 'Garden path',
    paragraphs: [
      'The gravel has sunk on the left. After rain the line of the path shows as a darker thread, and the rosemary leans over it.',
    ],
    linkId: 'moss',
    linkLead: 'See',
    backlinks: ['walks'],
  },
  {
    id: 'ink',
    title: 'Oxblood ink, first fill',
    when: 'Tuesday',
    snippet: 'Brown in the pen, red only when it dries.',
    type: 'Journal',
    status: 'Filed',
    place: 'Desk',
    paragraphs: [
      'First fill of the oxblood. It looks brown in the pen and red only when it dries on the cotton paper. I wrote the date and nothing else.',
    ],
    backlinks: [],
  },
  {
    id: 'walks',
    title: 'Index of walks',
    when: '3 Apr',
    snippet: 'North wall, the path, the lane, the hill.',
    type: 'Index',
    status: 'Open',
    place: 'Around home',
    paragraphs: [
      'A list, not a story. North wall, the path after rain, the lane behind the bakery, the hill that faces the weather.',
    ],
    backlinks: ['moss', 'path'],
  },
]

const navIconProps = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const
const statusIconProps = { size: 14, strokeWidth: 1.75, 'aria-hidden': true } as const

function noteById(id: string) {
  return notes.find((item) => item.id === id)
}

export const Shell = observer(function Shell() {
  const { t } = useTranslation()
  const preview = useService(ComponentsPreviewService)
  const note = noteById(preview.activeNoteId) ?? notes[0]
  const linked = note.linkId ? noteById(note.linkId) : undefined
  const backlinks = notes.filter((item) => note.backlinks.includes(item.id))

  return (
    <div className="sd-desk">
      <div className="sd-columns-scroll">
        <div className="sd-columns">
          <aside data-testid="region-sidebar" className="sd-col sd-side">
            <p className="sd-side-mark">
              <Notebook size={18} strokeWidth={1.75} aria-hidden="true" />
              <span>home</span>
            </p>
            <p className="sd-kicker">Views</p>
            <button type="button" className="sd-nav">
              <BookOpen {...navIconProps} />
              All notes
            </button>
            <button type="button" className="sd-nav">
              <Inbox {...navIconProps} />
              Inbox
            </button>
            <button type="button" className="sd-nav">
              <FileText {...navIconProps} />
              Journal
            </button>
            <p className="sd-kicker">Folders</p>
            <button type="button" className="sd-nav" aria-current="page">
              <Folder {...navIconProps} />
              Field notes
            </button>
            <button type="button" className="sd-nav">
              <Folder {...navIconProps} />
              Reading
            </button>
          </aside>

          <section data-testid="region-notes" className="sd-col sd-notes" aria-label={t('shell.notes')}>
            <div className="sd-list-heading">
              <h2 className="sd-list-title">Field notes</h2>
              <p className="sd-list-count">{notes.length} notes</p>
            </div>
            <div className="sd-note-list">
              {notes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="sd-note"
                  aria-current={item.id === note.id ? 'true' : undefined}
                  onClick={() => preview.selectNote(item.id)}
                >
                  <span className="sd-note-heading">
                    <span className="sd-note-name">{item.title}</span>
                    <span className="sd-note-day">{item.when}</span>
                  </span>
                  <span className="sd-note-meta">{item.snippet}</span>
                </button>
              ))}
            </div>
          </section>

          <article data-testid="region-editor" className="sd-col sd-editor">
            <div className="sd-editor-tabbar" aria-label={t('shell.openNotes')}>
              <div className="sd-editor-tab" aria-current="page">
                <FileText {...statusIconProps} />
                <span className="sd-editor-tab-label">{note.title}</span>
              </div>
            </div>
            <div className="sd-editor-paper">
              <h1 className="sd-note-title">{note.title}</h1>
              <p className="sd-note-when">{note.when}</p>
              <div className="sd-note-body">
                {note.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {linked && note.linkLead ? (
                  <p>
                    {note.linkLead}{' '}
                    <button type="button" className="sd-wikilink" onClick={() => preview.selectNote(linked.id)}>
                      [[{linked.title}]]
                    </button>
                    .
                  </p>
                ) : null}
              </div>
            </div>
          </article>

          <aside data-testid="region-inspector" className="sd-col sd-inspector" aria-label={t('shell.inspector')}>
            <p className="sd-kicker">Properties</p>
            <dl className="sd-props">
              <div>
                <dt>Type</dt>
                <dd>{note.type}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{note.status}</dd>
              </div>
              <div>
                <dt>Place</dt>
                <dd>{note.place}</dd>
              </div>
            </dl>
            <p className="sd-kicker">Backlinks</p>
            {backlinks.length === 0 ? <p className="sd-empty">No notes link here yet.</p> : null}
            {backlinks.map((item) => (
              <button key={item.id} type="button" className="sd-backlink" onClick={() => preview.selectNote(item.id)}>
                <FileText {...statusIconProps} />
                <span>{item.title}</span>
              </button>
            ))}
          </aside>
        </div>
      </div>
      <footer data-testid="region-statusbar" className="sd-status">
        <span className="sd-status-item">
          <Home {...statusIconProps} />
          home
        </span>
        <span className="sd-status-item">
          <GitBranch {...statusIconProps} />
          main
        </span>
        <span className="sd-status-item">
          <Search {...statusIconProps} />
          {t('shell.indexReady')}
        </span>
        <span className="sd-status-item">
          <MessageCircle {...statusIconProps} />
          Ask
        </span>
        <span className="sd-status-item">
          <Check {...statusIconProps} />
          {t('shell.upToDate')}
        </span>
        <span className="sd-status-item sd-status-end">0.1.0</span>
      </footer>
    </div>
  )
})
