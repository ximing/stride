import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import type { PreviewTheme } from './preview.service'

const LayerContext = createContext<HTMLElement | null>(null)

export function useLayer() {
  return useContext(LayerContext)
}

export function DesignLayer({ theme, children }: { theme: PreviewTheme; children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const ref = useCallback((next: HTMLDivElement | null) => {
    setNode(next)
  }, [])
  return (
    <LayerContext.Provider value={node}>
      <div ref={ref} className="sd-preview" data-testid="design-preview" data-theme={theme}>
        {children}
      </div>
    </LayerContext.Provider>
  )
}
