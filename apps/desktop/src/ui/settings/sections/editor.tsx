import { NotePencil } from '@phosphor-icons/react/NotePencil'
import { ComingSoonSection } from './placeholder'

export function EditorSection() {
  return (
    <ComingSoonSection
      icon={NotePencil}
      title="Coming soon"
      body="Editor preferences like autosave debounce land here in T7.2."
      testId="settings-section-editor"
    />
  )
}
