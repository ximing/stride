import {
  Archive,
  BookOpen,
  Check,
  Folder,
  Inbox,
  Info,
  Link as LinkIcon,
  Monitor,
  Moon,
  Pencil,
  Pin,
  Plus,
  Sun,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { bindServices, observer, useService } from '@rabjs/react'
import { Button, IconButton } from '../ui/primitives/button'
import { Input } from '../ui/primitives/input'
import { DesignLayer } from '../ui/primitives/layer'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/primitives/menu'
import { Modal, ModalClose, ModalContent, ModalTrigger } from '../ui/primitives/modal'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/primitives/popover'
import { ComponentsPreviewService } from '../ui/primitives/preview.service'
import { Select } from '../ui/primitives/select'
import { Shell } from '../ui/shell/shell'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/primitives/tabs'
import { Notice, Toaster } from '../ui/primitives/toast'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/primitives/tooltip'
import '../ui/tokens.css'
import './components-page.css'

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const

const NOTE_TYPE_OPTIONS = [
  { value: 'journal', label: 'Journal' },
  { value: 'note', label: 'Note' },
  { value: 'index', label: 'Index' },
]

const iconProps = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

const ComponentsPreview = observer(function ComponentsPreview() {
  const preview = useService(ComponentsPreviewService)
  const [noteType, setNoteType] = useState('journal')
  const [pinned, setPinned] = useState(true)

  return (
    <DesignLayer theme={preview.theme}>
      <TooltipProvider>
        <Toaster>
          <div className="sd-components-page">
            <header className="sd-components-header">
              <div>
                <h1 className="sd-components-title">Components</h1>
                <p className="sd-components-intro">Shared controls, overlays, and workspace composition.</p>
              </div>
              <div className="sd-themes" role="group" aria-label="Theme">
                {THEMES.map(({ value, label, icon: Glyph }) => (
                  <Button
                    key={value}
                    tone="quiet"
                    size="sm"
                    className="sd-theme"
                    data-testid={`theme-${value}`}
                    aria-pressed={preview.theme === value}
                    icon={<Glyph size={14} strokeWidth={1.75} aria-hidden="true" />}
                    onClick={() => preview.setTheme(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </header>

            <main className="sd-components-main">
              <section className="sd-component-section" aria-labelledby="buttons-title">
                <div className="sd-component-section-heading">
                  <h2 id="buttons-title" className="sd-component-section-title">Buttons</h2>
                  <p className="sd-component-section-copy">Tone communicates intent; size matches the surrounding density.</p>
                </div>
                <div className="sd-component-demo">
                  <div className="sd-demo-row">
                    <p className="sd-demo-label">Tones</p>
                    <div className="sd-demo-actions">
                      <Button tone="primary" icon={<Plus {...iconProps} />}>New note</Button>
                      <Button tone="secondary" icon={<Pencil {...iconProps} />}>Edit</Button>
                      <Button tone="quiet" icon={<Folder {...iconProps} />}>Move</Button>
                      <Button tone="danger" icon={<Trash2 {...iconProps} />}>Delete</Button>
                      <Button tone="secondary" icon={<Archive {...iconProps} />} disabled>Archive</Button>
                    </div>
                  </div>
                  <div className="sd-demo-row">
                    <p className="sd-demo-label">Sizes</p>
                    <div className="sd-demo-actions">
                      <Button tone="secondary" size="sm">Small</Button>
                      <Button tone="secondary" size="md">Medium</Button>
                      <Button tone="primary" size="lg">Large</Button>
                    </div>
                  </div>
                  <div className="sd-demo-row">
                    <p className="sd-demo-label">Icon buttons</p>
                    <div className="sd-demo-actions">
                      <IconButton icon={Plus} label="Add note" />
                      <IconButton
                        icon={Pin}
                        label={pinned ? 'Unpin note' : 'Pin note'}
                        active={pinned}
                        onClick={() => setPinned(!pinned)}
                      />
                      <IconButton icon={Archive} label="Archive note" disabled />
                    </div>
                  </div>
                </div>
              </section>

              <section className="sd-component-section" aria-labelledby="fields-title">
                <div className="sd-component-section-heading">
                  <h2 id="fields-title" className="sd-component-section-title">Fields</h2>
                  <p className="sd-component-section-copy">Text inputs and Select share labels, focus, and bordered surfaces.</p>
                </div>
                <div className="sd-component-fields">
                  <div className="sd-component-field">
                    <Input label="Note title" defaultValue="Moss on the north wall" />
                  </div>
                  <div className="sd-component-field">
                    <Input label="Search notes" placeholder="Find a note" type="search" />
                  </div>
                  <div className="sd-component-field">
                    <Select
                      label="Note type"
                      value={noteType}
                      onValueChange={setNoteType}
                      options={NOTE_TYPE_OPTIONS}
                      data-testid="note-type-select"
                    />
                  </div>
                </div>
              </section>

              <section className="sd-component-section" aria-labelledby="tabs-title">
                <div className="sd-component-section-heading">
                  <h2 id="tabs-title" className="sd-component-section-title">Tabs</h2>
                  <p className="sd-component-section-copy">Switch between related views without leaving the note.</p>
                </div>
                <Tabs defaultValue="write" className="sd-component-tabs">
                  <TabsList aria-label="Note view">
                    <TabsTrigger value="write">
                      <Pencil {...iconProps} />
                      Write
                    </TabsTrigger>
                    <TabsTrigger value="preview">
                      <BookOpen {...iconProps} />
                      Preview
                    </TabsTrigger>
                    <TabsTrigger value="details">
                      <Info {...iconProps} />
                      Details
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="write" className="sd-component-tab-panel">
                    <p>Drafting keeps the note measure and writing tools in focus.</p>
                  </TabsContent>
                  <TabsContent value="preview" className="sd-component-tab-panel">
                    <p>Preview checks the rendered note without leaving this view.</p>
                  </TabsContent>
                  <TabsContent value="details" className="sd-component-tab-panel">
                    <p>Note properties and links stay beside the content.</p>
                  </TabsContent>
                </Tabs>
              </section>

              <section className="sd-component-section" aria-labelledby="overlays-title">
                <div className="sd-component-section-heading">
                  <h2 id="overlays-title" className="sd-component-section-title">Overlays</h2>
                  <p className="sd-component-section-copy">Menus, dialogs, and popovers share elevation and focus behavior.</p>
                </div>
                <div className="sd-demo-actions">
                  <Menu>
                    <MenuTrigger asChild>
                      <Button tone="secondary" icon={<Folder {...iconProps} />}>Move</Button>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem>
                        <Folder {...iconProps} />
                        Field notes
                      </MenuItem>
                      <MenuItem>
                        <BookOpen {...iconProps} />
                        Reading
                      </MenuItem>
                      <MenuItem>
                        <Inbox {...iconProps} />
                        Inbox
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                  <Modal>
                    <ModalTrigger asChild>
                      <Button tone="secondary" icon={<Pencil {...iconProps} />}>Rename</Button>
                    </ModalTrigger>
                    <ModalContent title="Rename note" description="The file name follows the title.">
                      <Input label="Title" defaultValue="Moss on the north wall" />
                      <div className="sd-modal-actions">
                        <ModalClose asChild>
                          <Button tone="quiet">Cancel</Button>
                        </ModalClose>
                        <ModalClose asChild>
                          <Button
                            tone="primary"
                            onClick={() => preview.showToast('Renamed', 'Moss on the north wall')}
                          >
                            Rename
                          </Button>
                        </ModalClose>
                      </div>
                    </ModalContent>
                  </Modal>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button tone="secondary" icon={<LinkIcon {...iconProps} />}>Link</Button>
                    </PopoverTrigger>
                    <PopoverContent>
                      <p className="sd-pop-title">Link a note</p>
                      <Input label="Title" placeholder="Index of walks" />
                    </PopoverContent>
                  </Popover>
                </div>
              </section>

              <section className="sd-component-section" aria-labelledby="feedback-title">
                <div className="sd-component-section-heading">
                  <h2 id="feedback-title" className="sd-component-section-title">Feedback</h2>
                  <p className="sd-component-section-copy">Tooltips explain controls; toasts confirm completed actions.</p>
                </div>
                <div className="sd-demo-actions">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button tone="secondary" icon={<Info {...iconProps} />}>About</Button>
                    </TooltipTrigger>
                    <TooltipContent>Still a draft from this morning.</TooltipContent>
                  </Tooltip>
                  <Button
                    tone="secondary"
                    icon={<Check {...iconProps} />}
                    onClick={() => preview.showToast('Saved', 'Moss on the north wall is on this Mac.')}
                  >
                    Save
                  </Button>
                </div>
              </section>

              <section className="sd-component-section sd-workspace-section" aria-labelledby="workspace-title">
                <div className="sd-component-section-heading">
                  <h2 id="workspace-title" className="sd-component-section-title">Workspace</h2>
                  <p className="sd-component-section-copy">Neutral navigation surrounds a readable, serif note surface.</p>
                </div>
                <div className="sd-workspace-preview">
                  <Shell />
                </div>
              </section>
            </main>

            <Notice
              open={preview.toastOpen}
              title={preview.toastTitle}
              description={preview.toastBody}
              onOpenChange={(open) => preview.setToastOpen(open)}
            />
          </div>
        </Toaster>
      </TooltipProvider>
    </DesignLayer>
  )
})

export const ComponentsPage = bindServices(ComponentsPreview, [ComponentsPreviewService])
