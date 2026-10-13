import {
  BookOpen,
  Check,
  FolderSimple,
  GitBranch,
  House,
  MagnifyingGlass,
  Note,
  Notebook,
  Tray,
} from '@phosphor-icons/react'
import { observer, useService } from '@rabjs/react'
import { Mark } from './icon'
import { ComponentsPreviewService } from './preview.service'

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

function noteById(id: string) {
  return notes.find((item) => item.id === id)
}

export const Shell = observer(function Shell() {
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
              <Mark icon={Notebook} size={20} />
              <span>home</span>
            </p>
            <p className="sd-kicker">Views</p>
            <button type="button" className="sd-nav">
              <Mark icon={BookOpen} />
              All notes
            </button>
            <button type="button" className="sd-nav">
              <Mark icon={Tray} />
              Inbox
            </button>
            <button type="button" className="sd-nav">
              <Mark icon={Note} />
              Journal
            </button>
            <p className="sd-kicker">Folders</p>
            <button type="button" className="sd-nav" aria-current="page">
              <Mark icon={FolderSimple} />
              Field notes
            </button>
            <button type="button" className="sd-nav">
              <Mark icon={FolderSimple} />
              Reading
            </button>
          </aside>

          <section data-testid="region-notes" className="sd-col sd-notes" aria-label="Notes">
            <h2 className="sd-list-title">Field notes</h2>
            <p className="sd-list-count">{notes.length} notes</p>
            {notes.map((item) => (
              <button
                key={item.id}
                type="button"
                className="sd-note"
                aria-current={item.id === note.id ? 'true' : undefined}
                onClick={() => preview.selectNote(item.id)}
              >
                <span className="sd-note-name">{item.title}</span>
                <span className="sd-note-day">{item.when}</span>
                <span className="sd-note-meta">{item.snippet}</span>
              </button>
            ))}
          </section>

          <article data-testid="region-editor" className="sd-col sd-editor">
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
          </article>

          <aside data-testid="region-inspector" className="sd-col sd-inspector" aria-label="Inspector">
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
                {item.title}
              </button>
            ))}
          </aside>
        </div>
      </div>
      <footer data-testid="region-statusbar" className="sd-status">
        <span className="sd-status-item">
          <Mark icon={House} size={14} />
          home
        </span>
        <span className="sd-status-item">
          <Mark icon={GitBranch} size={14} />
          main
        </span>
        <span className="sd-status-item">
          <Mark icon={MagnifyingGlass} size={14} />
          Index ready
        </span>
        <span className="sd-status-item">
          <Mark icon={Note} size={14} />
          Ask
        </span>
        <span className="sd-status-item">
          <Mark icon={Check} size={14} />
          Up to date
        </span>
        <span className="sd-status-item sd-status-end">0.1.0</span>
      </footer>
    </div>
  )
})
