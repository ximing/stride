// TypeScript's DOM lib omits directory listing, handle permissions, and move().
export {}

declare global {
  interface FileSystemHandle {
    queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
    // Absent in browsers that have the picker but not FileSystemHandle.move().
    move?(destination: FileSystemDirectoryHandle, name?: string): Promise<void>
  }

  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  }
}
