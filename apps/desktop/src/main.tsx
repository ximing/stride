import { register, resolve } from '@rabjs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { ChatService, GitService, SettingsService, UpdateService } from './services/panels.service'
import { VaultService } from './services/vault.service'
import './styles.css'

register(VaultService)
register(GitService)
register(SettingsService)
register(ChatService)
register(UpdateService)

void resolve(SettingsService).load()

if (import.meta.env.DEV) {
  void import('./inspect-client').then((mod) => mod.startInspectClient()).catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
