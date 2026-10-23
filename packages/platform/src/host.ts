export interface HostPaths {
  homeDirectory(): Promise<string>
}

export function memoryHostPaths(homeDirectory: string): HostPaths {
  return {
    homeDirectory() {
      return Promise.resolve(homeDirectory)
    },
  }
}
