import { describe, expect, it } from 'vitest'
import { registerAppDataStoreContract } from './appdata-contract.ts'
import { MemoryAppDataStore } from './index.ts'

registerAppDataStoreContract('MemoryAppDataStore', () => new MemoryAppDataStore())

describe('MemoryAppDataStore', () => {
  it('isolates instances', async () => {
    const a = new MemoryAppDataStore()
    const b = new MemoryAppDataStore()
    await a.writeText('chats/v1/s.json', '{}')
    expect(await b.readText('chats/v1/s.json')).toBeNull()
    expect(await b.list('')).toEqual([])
  })
})
