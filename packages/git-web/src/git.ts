import { unavailableGit, type GitBackend } from '@stride/platform'

export function browserGitBackend(): GitBackend {
  return unavailableGit()
}
