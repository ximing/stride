// Settings section registry: the single list the page's nav and content area
// render from, in fixed order. Forms live in ./sections/*.

import type { Icon } from '@phosphor-icons/react'
import { ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise'
import { GitBranch } from '@phosphor-icons/react/GitBranch'
import { Keyboard } from '@phosphor-icons/react/Keyboard'
import { NotePencil } from '@phosphor-icons/react/NotePencil'
import { Palette } from '@phosphor-icons/react/Palette'
import { ShieldCheck } from '@phosphor-icons/react/ShieldCheck'
import { Sparkle } from '@phosphor-icons/react/Sparkle'
import { Vault } from '@phosphor-icons/react/Vault'
import { VectorThree } from '@phosphor-icons/react/VectorThree'
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
  icon: Icon
  component: ComponentType
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'appearance', title: 'Appearance', icon: Palette, component: AppearanceSection },
  { id: 'editor', title: 'Editor', icon: NotePencil, component: EditorSection },
  { id: 'ai', title: 'AI', icon: Sparkle, component: AiSection },
  { id: 'embedding', title: 'Embedding', icon: VectorThree, component: EmbeddingSection },
  { id: 'git', title: 'Git', icon: GitBranch, component: GitSection },
  { id: 'updates', title: 'Updates', icon: ArrowClockwise, component: UpdatesSection },
  { id: 'privacy', title: 'Privacy', icon: ShieldCheck, component: PrivacySection },
  { id: 'shortcuts', title: 'Keyboard Shortcuts', icon: Keyboard, component: ShortcutsSection },
  { id: 'vault', title: 'This Vault', icon: Vault, component: VaultSection },
]
