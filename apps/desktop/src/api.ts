import type { StrideNote, TipTapNode } from '@stride/core/note'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

export interface OpenedVault {
  path: string
  broad: boolean
  dedicated: boolean
  notes: StrideNote[]
}

export interface PublicSettings {
  embedding: { endpoint: string; model: string; keyMask: string; dim: number }
  llmConfigs: { id: string; name: string; provider: string; model: string; baseUrl: string; keyMask: string; isDefault: boolean }[]
  releasesUrl: string
}

export interface UpdateView {
  phase: 'idle' | 'available' | 'downloading' | 'ready'
  progress: number
  selected: { version: string; assetName: string; assetUrl: string } | null
  version: string
}

export const api = {
  openVault(path: string) {
    return request<OpenedVault>('/api/vault/open', { method: 'POST', body: JSON.stringify({ path }) })
  },
  createNote(title?: string) {
    return request<StrideNote>('/api/notes', { method: 'POST', body: JSON.stringify({ title }) })
  },
  saveNote(note: StrideNote) {
    return request<StrideNote>(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ note }),
    })
  },
  search(query: string) {
    return request<{ mode: string; hits: { id: string; score: number }[]; error?: string }>('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    })
  },
  gitStatus() {
    return request<{ repo: boolean; porcelain: string; clean: boolean }>('/api/git/status')
  },
  gitDiff(id?: string) {
    return request<{ diff: string }>(`/api/git/diff${id ? `?id=${encodeURIComponent(id)}` : ''}`)
  },
  gitInit() {
    return request<{ repo: boolean; porcelain: string }>('/api/git/init', { method: 'POST', body: '{}' })
  },
  gitCommit(message: string) {
    return request<{ output: string }>('/api/git/commit', { method: 'POST', body: JSON.stringify({ message }) })
  },
  gitHistory(id?: string) {
    return request<{ history: { hash: string; subject: string }[] }>(`/api/git/history${id ? `?id=${encodeURIComponent(id)}` : ''}`)
  },
  gitPull() {
    return request<{ conflict: boolean; files: string[]; output: string; notes: StrideNote[] }>('/api/git/pull', {
      method: 'POST',
      body: '{}',
    })
  },
  gitPush() {
    return request<{ output: string }>('/api/git/push', { method: 'POST', body: '{}' })
  },
  gitRemote(url: string) {
    return request<{ ok: boolean }>('/api/git/remote', { method: 'POST', body: JSON.stringify({ url }) })
  },
  gitResolve(id: string, side: 'ours' | 'theirs') {
    return request<{ notes: StrideNote[] }>('/api/git/resolve', { method: 'POST', body: JSON.stringify({ id, side }) })
  },
  settings() {
    return request<PublicSettings>('/api/settings')
  },
  saveSettings(body: unknown) {
    return request<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) })
  },
  chat(message: string, activeId: string) {
    return request<{ reply: string; history: { role: 'user' | 'assistant'; text: string }[] }>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message, activeId }),
    })
  },
  updates() {
    return request<UpdateView>('/api/updates')
  },
  checkUpdates() {
    return request<UpdateView>('/api/updates/check', { method: 'POST', body: '{}' })
  },
  downloadUpdate() {
    return request<UpdateView>('/api/updates/download', { method: 'POST', body: '{}' })
  },
  dismissUpdate() {
    return request<UpdateView>('/api/updates/dismiss', { method: 'POST', body: '{}' })
  },
  confirmUpdate() {
    return request<UpdateView & { restartRequested?: boolean }>('/api/updates/confirm', { method: 'POST', body: '{}' })
  },
}

export type { StrideNote, TipTapNode }
