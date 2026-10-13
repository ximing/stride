// The confirm response has to leave before this process stops. A synchronous
// process.exit drops that response, and the window then stays on the old build.
const HANDOFF_DELAY_MS = 500

export function exitCurrentProcess(exitImpl: (code: number) => void = (code) => process.exit(code)): void {
  setTimeout(() => exitImpl(0), HANDOFF_DELAY_MS)
}
