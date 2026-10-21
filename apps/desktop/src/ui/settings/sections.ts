// Settings section registry: the single list the page's nav and content area
// render from, in fixed order. Forms live in ./sections/*.

import {
  GitBranch,
  Keyboard,
  Network,
  NotebookPen,
  Palette,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Vault,
  type LucideIcon,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { SettingsSectionId } from '../../services/settings-page.service'
import { AppearanceSection } from './sections/appearance'
import { AiSection } from './sections/ai'
import { EditorSection } from './sections/editor'
import { EmbeddingSection } from './sections/embedding'
import { GitSection } from './sections/git'
import { PrivacySection } from './sections/privacy'
import { ShortcutsSection } from './sections/shortcuts'
import { UpdatesSection } from './sections/updates'
import { VaultSection } from './sections/vault'

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  icon: LucideIcon
  component: ComponentType
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'appearance', title: 'Appearance', icon: Palette, component: AppearanceSection },
  { id: 'editor', title: 'Editor', icon: NotebookPen, component: EditorSection },
  { id: 'ai', title: 'AI', icon: Sparkles, component: AiSection },
  { id: 'embedding', title: 'Embedding', icon: Network, component: EmbeddingSection },
  { id: 'git', title: 'Git', icon: GitBranch, component: GitSection },
  { id: 'updates', title: 'Updates', icon: RefreshCw, component: UpdatesSection },
  { id: 'privacy', title: 'Privacy', icon: ShieldCheck, component: PrivacySection },
  { id: 'shortcuts', title: 'Keyboard Shortcuts', icon: Keyboard, component: ShortcutsSection },
  { id: 'vault', title: 'This Vault', icon: Vault, component: VaultSection },
]
