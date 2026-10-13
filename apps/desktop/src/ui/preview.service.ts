import { Service } from '@rabjs/react'

export type PreviewTheme = 'light' | 'dark' | 'system'

export class ComponentsPreviewService extends Service {
  theme: PreviewTheme = 'system'
  activeNoteId = 'moss'
  toastOpen = false
  toastTitle = ''
  toastBody = ''

  setTheme(theme: PreviewTheme) {
    this.theme = theme
  }

  selectNote(id: string) {
    this.activeNoteId = id
  }

  showToast(title: string, body = '') {
    this.toastTitle = title
    this.toastBody = body
    this.toastOpen = true
  }

  setToastOpen(open: boolean) {
    this.toastOpen = open
  }
}
