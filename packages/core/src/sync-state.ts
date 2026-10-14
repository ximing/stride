export type SyncState = 'idle' | 'syncing' | 'pull_required' | 'conflict' | 'error'

export function syncState(input: {
  busy: boolean
  conflict: boolean
  behind: number
  error: boolean
}): SyncState {
  if (input.busy) return 'syncing'
  if (input.conflict) return 'conflict'
  if (input.error) return 'error'
  if (input.behind > 0) return 'pull_required'
  return 'idle'
}
