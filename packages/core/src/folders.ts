import type { FileSystemBackend } from '@stride/platform'
import { notePath } from './vault.ts'

function assertFolder(folderPath: string): string {
  const path = folderPath.trim()
  if (!path || path.includes('..') || path.startsWith('/')) {
    throw new Error('Invalid folder')
  }
  return path
}

export async function listFolders(fs: FileSystemBackend): Promise<string[]> {
  const folders: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.list(dir)
    for (const entry of entries) {
      if (entry.kind !== 'directory') continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      folders.push(rel)
      await walk(rel)
    }
  }
  await walk('')
  return folders.sort()
}

export async function createFolder(fs: FileSystemBackend, folderPath: string): Promise<void> {
  const path = assertFolder(folderPath)
  await fs.mkdir(path)
}

export async function renameFolder(fs: FileSystemBackend, from: string, to: string): Promise<void> {
  const source = assertFolder(from)
  const target = assertFolder(to)
  await fs.rename(source, target)
}

export async function deleteFolder(
  fs: FileSystemBackend,
  folderPath: string,
  noteIds: string[],
): Promise<void> {
  const prefix = `${folderPath}/`
  if (noteIds.some((id) => id === folderPath || id.startsWith(prefix))) {
    throw new Error('Folder is not empty')
  }
  await fs.remove(folderPath)
}

export async function moveNotePath(fs: FileSystemBackend, fromId: string, destFolder: string): Promise<string> {
  const basename = fromId.split('/').pop() ?? ''
  const toId = destFolder ? `${destFolder}/${basename}` : basename
  if (toId !== fromId && (await fs.stat(notePath(toId))) !== null) {
    throw new Error('A note is already there')
  }
  if (toId !== fromId) {
    await fs.rename(notePath(fromId), notePath(toId))
  }
  return toId
}
