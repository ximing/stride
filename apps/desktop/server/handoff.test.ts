// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { exitCurrentProcess } from './handoff.ts'

describe('update handoff', () => {
  const timers: ReturnType<typeof setTimeout>[] = []

  afterEach(() => {
    for (const timer of timers.splice(0)) clearTimeout(timer)
  })

  it('asks the current process to exit only after the confirm response can flush', async () => {
    let code: number | null = null
    exitCurrentProcess((next) => {
      code = next
    })
    expect(code).toBeNull()
    await new Promise<void>((resolve) => {
      timers.push(setTimeout(resolve, 700))
    })
    expect(code).toBe(0)
  })
})
