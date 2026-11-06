import { afterEach, describe, expect, it } from 'vitest'
import { MemoryAppDataStore } from '@stride/platform'
import { resetAppDataStore, resolveAppDataStore, setAppDataStore } from './app-data'

describe('resolveAppDataStore', () => {
  afterEach(() => {
    resetAppDataStore()
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('returns the override until reset', async () => {
    const store = new MemoryAppDataStore()
    setAppDataStore({ store, persistent: false })
    const resolved = await resolveAppDataStore()
    expect(resolved.store).toBe(store)
    expect(resolved.persistent).toBe(false)
  })

  it('resolves the override factory lazily', async () => {
    let calls = 0
    setAppDataStore(() => {
      calls += 1
      return { store: new MemoryAppDataStore(), persistent: false }
    })
    expect(calls).toBe(0)
    await resolveAppDataStore()
    expect(calls).toBe(1)
  })

  it('uses a non-persistent memory store for the memory fixture', async () => {
    ;(globalThis as { window?: unknown }).window = { location: { search: '?fixture=memory' } }
    const first = await resolveAppDataStore()
    expect(first.persistent).toBe(false)
    expect(first.store).toBeInstanceOf(MemoryAppDataStore)
    const second = await resolveAppDataStore()
    expect(second.store).toBe(first.store)
  })
})
