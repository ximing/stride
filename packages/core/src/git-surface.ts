export type GitSurface = 'unavailable' | 'disabled' | 'blocked' | 'needs-init' | 'ready'

export function gitSurface(input: {
  backendAvailable: boolean
  gitEnabled: boolean
  isRepo: boolean
  broadBlocked: boolean
}): GitSurface {
  if (input.backendAvailable === false) return 'unavailable'
  if (input.gitEnabled === false) return 'disabled'
  if (input.isRepo) return 'ready'
  if (input.broadBlocked) return 'blocked'
  return 'needs-init'
}
