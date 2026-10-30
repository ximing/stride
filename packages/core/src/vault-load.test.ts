import { MemoryFileSystem } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import { createNote, serializeNote } from './note.ts'
import { loadNotes, loadNotesWhile, NOTE_READ_CONCURRENCY } from './vault.ts'

class CountingFs extends MemoryFileSystem {
  noteReads = 0
  inFlight = 0
  maxInFlight = 0
  hold: Promise<void> | null = null
  failPath = ''
  slowPath = ''

  override async readText(path: string): Promise<string> {
    if (!path.endsWith('.stride.json')) return super.readText(path)
    this.noteReads += 1
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.hold) await this.hold
      if (path === this.slowPath) await new Promise((resolve) => setTimeout(resolve, 30))
      if (path === this.failPath) throw new Error('disk offline')
      return await super.readText(path)
    } finally {
      this.inFlight -= 1
    }
  }
}

async function seed(fs: MemoryFileSystem, count: number) {
  for (let index = 0; index < count; index += 1) {
    const id = `n-${String(index).padStart(2, '0')}`
    const note = createNote(id, `Title ${index}`)
    await fs.writeText(`${id}.stride.json`, serializeNote(note))
  }
}

describe('loadNotesWhile', () => {
  it('keeps sorted order and caps in-flight reads', async () => {
    const fs = new CountingFs('ordered')
    await seed(fs, 20)
    fs.slowPath = 'n-00.stride.json'
    const notes = await loadNotes(fs)
    expect(notes.map((note) => note.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `n-${String(index).padStart(2, '0')}`),
    )
    expect(fs.noteReads).toBe(20)
    expect(fs.maxInFlight).toBe(NOTE_READ_CONCURRENCY)
    expect(fs.maxInFlight).toBeLessThanOrEqual(8)
  })

  it('skips an unreadable note and still throws a real read error', async () => {
    const fs = new CountingFs('mixed')
    await seed(fs, 3)
    await fs.writeText('n-01.stride.json', '{')
    const notes = await loadNotes(fs)
    expect(notes.map((note) => note.id)).toEqual(['n-00', 'n-02'])
    expect(await fs.readText('n-01.stride.json')).toBe('{')

    const failing = new CountingFs('failing')
    await seed(failing, 4)
    failing.failPath = 'n-02.stride.json'
    await expect(loadNotes(failing)).rejects.toThrow('disk offline')
  })

  it('stops issuing reads when cancelled and does not surface that error', async () => {
    const fs = new CountingFs('cancel')
    await seed(fs, 20)
    let release!: () => void
    fs.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    fs.failPath = 'n-00.stride.json'
    let allow = true
    const pending = loadNotesWhile(fs, () => allow)
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (fs.noteReads > 0) {
          clearInterval(timer)
          resolve()
        }
      }, 1)
      setTimeout(() => {
        clearInterval(timer)
        reject(new Error('reads did not start'))
      }, 1000)
    })
    allow = false
    release()
    await expect(pending).resolves.toBeNull()
    expect(fs.noteReads).toBeGreaterThan(0)
    expect(fs.noteReads).toBeLessThanOrEqual(NOTE_READ_CONCURRENCY)
    expect(fs.maxInFlight).toBeLessThanOrEqual(NOTE_READ_CONCURRENCY)
  })

  it('propagates a directory listing error', async () => {
    const fs = new MemoryFileSystem('list-fail')
    fs.list = async () => {
      throw new Error('list failed')
    }
    await expect(loadNotes(fs)).rejects.toThrow('list failed')
  })
})
