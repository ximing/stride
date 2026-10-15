// Saved Views (T6.6): named, git-synced filter views stored as `views/*.json`
// inside the vault. Pure schema/parse/serialize/slug/order/match logic lives
// here with no rabjs or DOM dependencies so it stays unit-testable; the app's
// ViewsService is the reactive shell around these primitives.
//
// File schema (version 1):
//   {
//     "version": 1,
//     "name": "Reading list",               // required, non-empty
//     "icon": "📚",                          // optional display glyph
//     "type": "Article",                     // optional note.type constraint
//     "propertyFilters": [                   // optional, AND-combined
//       { "key": "status", "op": "eq", "value": "reading" },
//       { "key": "author", "op": "contains", "value": "borges" },
//       { "key": "due", "op": "exists" }
//     ],
//     "sort": { "key": "mtime", "dir": "desc" },  // optional; keys mirror stride:list
//     "archived": true                       // optional; include archived notes
//   }
//
// Parsing is garbage-tolerant: unreadable JSON, a wrong version, or a missing
// name rejects the file (it is skipped, never crashed on); unknown fields are
// dropped; invalid optional fields are dropped individually.
//
// Sidebar order is NOT stored in the view files. It lives in a single
// `.stride/views-order.json` so a drag rewrites one tiny file instead of
// dirtying every view in git; views missing from the order file (e.g. freshly
// pulled) append at the end sorted by name, and stale slugs are ignored.

import type { FileSystemBackend } from '@stride/platform'
import { isArchived, type NoteProperty, type StrideNote } from './note.ts'

export const VIEWS_DIR = 'views'
export const VIEWS_ORDER_PATH = '.stride/views-order.json'
export const VIEW_FILE_VERSION = 1
export const VIEWS_ORDER_VERSION = 1
/** listFilter value prefix that activates a saved view (remainder is the file slug). */
export const VIEW_FILTER_PREFIX = 'view:'

export type ViewFilterOp = 'eq' | 'contains' | 'exists'
export const VIEW_FILTER_OPS: readonly ViewFilterOp[] = ['eq', 'contains', 'exists']

export interface ViewPropertyFilter {
  key: string
  op: ViewFilterOp
  /** Required for eq/contains; ignored for exists. Compared case-insensitively for strings. */
  value?: string
}

export type ViewSortKey = 'mtime' | 'title' | 'created'
export type ViewSortDir = 'asc' | 'desc'
export const VIEW_SORT_KEYS: readonly ViewSortKey[] = ['mtime', 'title', 'created']

export interface ViewSort {
  key: ViewSortKey
  dir: ViewSortDir
}

export interface SavedView {
  version: number
  name: string
  icon?: string
  type?: string
  propertyFilters?: ViewPropertyFilter[]
  sort?: ViewSort
  archived?: boolean
}

/** A parsed view plus its file slug (basename under `views/`, without `.json`). */
export interface LoadedView {
  file: string
  view: SavedView
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function sanitizeFilter(value: unknown): ViewPropertyFilter | null {
  if (!isRecord(value)) return null
  const key = cleanText(value.key)
  if (!key) return null
  const op = value.op
  if (op !== 'eq' && op !== 'contains' && op !== 'exists') return null
  const filter: ViewPropertyFilter = { key, op }
  if (op !== 'exists') {
    const raw = value.value
    const text = typeof raw === 'string' ? raw
      : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw)
      : undefined
    // eq/contains without a usable value can only ever match noise; drop it.
    if (text === undefined) return null
    filter.value = text
  }
  return filter
}

function sanitizeSort(value: unknown): ViewSort | undefined {
  if (!isRecord(value)) return undefined
  const key = value.key
  const dir = value.dir
  if (key !== 'mtime' && key !== 'title' && key !== 'created') return undefined
  if (dir !== 'asc' && dir !== 'desc') return undefined
  return { key, dir }
}

/** Validate arbitrary JSON into a SavedView. Returns null for anything unusable. */
export function sanitizeView(raw: unknown): SavedView | null {
  if (!isRecord(raw)) return null
  if (raw.version !== VIEW_FILE_VERSION) return null
  const name = cleanText(raw.name)
  if (!name) return null
  const view: SavedView = { version: VIEW_FILE_VERSION, name }
  const icon = cleanText(raw.icon)
  if (icon) view.icon = icon
  const type = cleanText(raw.type)
  if (type) view.type = type
  if (Array.isArray(raw.propertyFilters)) {
    const filters = raw.propertyFilters
      .map(sanitizeFilter)
      .filter((filter): filter is ViewPropertyFilter => filter !== null)
    if (filters.length > 0) view.propertyFilters = filters
  }
  const sort = sanitizeSort(raw.sort)
  if (sort) view.sort = sort
  if (raw.archived === true) view.archived = true
  return view
}

/** Parse one `views/*.json` file. Garbage yields null (the file is skipped). */
export function parseViewFile(text: string): SavedView | null {
  try {
    return sanitizeView(JSON.parse(text))
  } catch {
    return null
  }
}

/** Stable serialization with fixed key order so git diffs stay minimal. */
export function serializeView(view: SavedView): string {
  const out: Record<string, unknown> = { version: VIEW_FILE_VERSION, name: view.name }
  if (view.icon) out.icon = view.icon
  if (view.type) out.type = view.type
  if (view.propertyFilters && view.propertyFilters.length > 0) {
    out.propertyFilters = view.propertyFilters.map((filter) =>
      filter.op === 'exists' ? { key: filter.key, op: filter.op } : { key: filter.key, op: filter.op, value: filter.value ?? '' },
    )
  }
  if (view.sort) out.sort = { key: view.sort.key, dir: view.sort.dir }
  if (view.archived === true) out.archived = true
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * Slug for a view name: lowercase, runs of non [a-z0-9 一-鿿] collapse to `-`.
 * Mirrors note id slugs (CJK kept) but falls back to "view" instead of "note".
 */
export function viewSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'view'
}

/** First slug not in `taken`: base, base-2, base-3, … */
export function dedupeViewSlug(base: string, taken: ReadonlySet<string>): string {
  let slug = base
  let n = 2
  while (taken.has(slug)) {
    slug = `${base}-${n}`
    n += 1
  }
  return slug
}

export function viewFilePath(file: string): string {
  return `${VIEWS_DIR}/${file}.json`
}

/** Read and parse every view file. Unparseable files are skipped, never thrown. */
export async function listViews(fs: FileSystemBackend): Promise<LoadedView[]> {
  const stat = await fs.stat(VIEWS_DIR)
  if (!stat || stat.kind !== 'directory') return []
  const entries = await fs.list(VIEWS_DIR)
  const views: LoadedView[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    if (!entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
    const file = entry.name.slice(0, -'.json'.length)
    if (!file) continue
    try {
      const view = parseViewFile(await fs.readText(viewFilePath(file)))
      if (view) views.push({ file, view })
    } catch {
      // A half-written or mid-merge file is skipped; the next watch tick retries.
    }
  }
  return views
}

export async function writeViewFile(fs: FileSystemBackend, file: string, view: SavedView): Promise<void> {
  try {
    await fs.mkdir(VIEWS_DIR)
  } catch {
    // mkdir is best-effort: backends auto-create parents on write, and an
    // already-existing directory must never block a save.
  }
  await fs.writeText(viewFilePath(file), serializeView(view))
}

export async function removeViewFile(fs: FileSystemBackend, file: string): Promise<void> {
  await fs.remove(viewFilePath(file))
}

// ---------- sidebar order (`.stride/views-order.json`) ----------

function sanitizeOrder(raw: unknown): string[] {
  if (!isRecord(raw)) return []
  if (raw.version !== VIEWS_ORDER_VERSION) return []
  if (!Array.isArray(raw.order)) return []
  const seen = new Set<string>()
  const order: string[] = []
  for (const entry of raw.order) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue
    seen.add(entry)
    order.push(entry)
  }
  return order
}

export async function readViewsOrder(fs: FileSystemBackend): Promise<string[]> {
  try {
    const stat = await fs.stat(VIEWS_ORDER_PATH)
    if (!stat || stat.kind !== 'file') return []
    return sanitizeOrder(JSON.parse(await fs.readText(VIEWS_ORDER_PATH)))
  } catch {
    return []
  }
}

export async function writeViewsOrder(fs: FileSystemBackend, order: readonly string[]): Promise<void> {
  await fs.writeText(VIEWS_ORDER_PATH, `${JSON.stringify({ version: VIEWS_ORDER_VERSION, order: [...order] }, null, 2)}\n`)
}

/**
 * Order the loaded views for the sidebar: order-file slugs first (stale slugs
 * dropped by construction), then unordered views by name for determinism.
 */
export function applyViewsOrder(views: readonly LoadedView[], order: readonly string[]): LoadedView[] {
  const rank = new Map(order.map((file, index) => [file, index]))
  return [...views].sort((a, b) => {
    const ra = rank.get(a.file)
    const rb = rank.get(b.file)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    const byName = a.view.name.localeCompare(b.view.name)
    if (byName !== 0) return byName
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  })
}

/** DnD helper: move `dragged` to `target`'s position. Unknown ids leave the list unchanged. */
export function moveViewBefore(files: readonly string[], dragged: string, target: string): string[] {
  if (dragged === target) return [...files]
  if (!files.includes(dragged) || !files.includes(target)) return [...files]
  const without = files.filter((file) => file !== dragged)
  const index = without.indexOf(target)
  return [...without.slice(0, index), dragged, ...without.slice(index)]
}

// ---------- filter engine ----------

function valueEquals(value: NoteProperty, needle: string): boolean {
  if (typeof value === 'string') return value.toLowerCase() === needle
  if (typeof value === 'number') {
    const numeric = Number(needle)
    return Number.isFinite(numeric) && value === numeric
  }
  if (typeof value === 'boolean') {
    if (needle === 'true') return value
    if (needle === 'false') return !value
    return false
  }
  return value.some((item) => item.toLowerCase() === needle)
}

function valueContains(value: NoteProperty, needle: string): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes(needle)
  if (typeof value === 'number') return String(value).includes(needle)
  if (typeof value === 'boolean') return (value ? 'true' : 'false').includes(needle)
  return value.some((item) => item.toLowerCase().includes(needle))
}

/** One property filter against one note. Missing property fails eq/contains, passes nothing else. */
export function matchesPropertyFilter(note: StrideNote, filter: ViewPropertyFilter): boolean {
  const present = Object.hasOwn(note.properties, filter.key)
  if (filter.op === 'exists') return present
  if (!present) return false
  const value = note.properties[filter.key]
  if (value === undefined) return false
  const needle = (filter.value ?? '').trim().toLowerCase()
  if (!needle) return false
  return filter.op === 'eq' ? valueEquals(value, needle) : valueContains(value, needle)
}

/**
 * A note belongs to a view when the type constraint and every property filter
 * pass. Type documents never appear in lists; archived notes only appear when
 * the view opts in (`archived: true`).
 */
export function noteMatchesView(note: StrideNote, view: SavedView): boolean {
  if (note.type === 'Type') return false
  if (view.archived !== true && isArchived(note)) return false
  if (view.type && note.type !== view.type) return false
  for (const filter of view.propertyFilters ?? []) {
    if (!matchesPropertyFilter(note, filter)) return false
  }
  return true
}

/** The note subset a saved view shows. Orthogonal to the inline list filter and search. */
export function applyViewFilter(notes: readonly StrideNote[], view: SavedView): StrideNote[] {
  return notes.filter((note) => noteMatchesView(note, view))
}
