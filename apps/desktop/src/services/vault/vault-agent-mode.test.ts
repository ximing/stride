import { has, register, resolve } from '@rabjs/react'
import { describe, expect, it } from 'vitest'
import { VaultService } from './vault.service'

describe('VaultService agent mode', () => {
  it('stays safe when no filesystem is open', async () => {
    if (!has(VaultService)) register(VaultService)
    const vault = resolve(VaultService)
    const previousFs = vault.fs
    const previousMode = vault.agentMode
    vault.fs = null
    vault.agentMode = 'safe'
    try {
      await vault.setAgentMode('safe')
      expect(vault.agentMode).toBe('safe')
      expect(vault.fs).toBeNull()
    } finally {
      vault.fs = previousFs
      vault.agentMode = previousMode
    }
  })
})
