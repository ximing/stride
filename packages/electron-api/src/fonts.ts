import { electronBridge } from './index.ts'

/** Installed font families from the Electron host. An unusable answer is an empty list. */
export async function listSystemFonts(): Promise<readonly string[]> {
  const result: unknown = await electronBridge().invoke('host:fonts')
  if (!Array.isArray(result)) return []
  return result.filter((name): name is string => typeof name === 'string')
}
