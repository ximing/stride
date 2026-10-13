import { Archive, Check, Desktop, FolderSimple, Info, LinkSimple, Moon, Notebook, PencilSimple, Plus, Sun, Tray, Trash } from '@phosphor-icons/react'
import { bindServices, observer, useService } from '@rabjs/react'
import { Button } from '../ui/button'
import { Mark } from '../ui/icon'
import { Input } from '../ui/input'
import { DesignLayer } from '../ui/layer'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/menu'
import { Modal, ModalClose, ModalContent, ModalTrigger } from '../ui/modal'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { ComponentsPreviewService } from '../ui/preview.service'
import { Shell } from '../ui/shell'
import { Notice, Toaster } from '../ui/toast'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import '../ui/tokens.css'

const ComponentsPreview = observer(function ComponentsPreview() {
  const preview = useService(ComponentsPreviewService)
  return (
    <DesignLayer theme={preview.theme}>
      <TooltipProvider>
        <Toaster>
          <header className="sd-top">
            <p className="sd-brand">
              <Mark icon={Notebook} size={22} />
              <span className="sd-brand-name">Stride</span>
            </p>
            <div className="sd-themes" role="group" aria-label="Theme">
              <button
                type="button"
                className="sd-theme"
                data-testid="theme-light"
                aria-pressed={preview.theme === 'light'}
                onClick={() => preview.setTheme('light')}
              >
                <Mark icon={Sun} size={16} />
                Light
              </button>
              <button
                type="button"
                className="sd-theme"
                data-testid="theme-dark"
                aria-pressed={preview.theme === 'dark'}
                onClick={() => preview.setTheme('dark')}
              >
                <Mark icon={Moon} size={16} />
                Dark
              </button>
              <button
                type="button"
                className="sd-theme"
                data-testid="theme-system"
                aria-pressed={preview.theme === 'system'}
                onClick={() => preview.setTheme('system')}
              >
                <Mark icon={Desktop} size={16} />
                System
              </button>
            </div>
          </header>

          <section className="sd-gallery" aria-label="Controls">
            <div className="sd-actions">
              <Button tone="primary" icon={<Mark icon={Plus} size={16} />}>New note</Button>
              <Button tone="quiet" icon={<Mark icon={PencilSimple} size={16} />}>Edit</Button>
              <Button tone="danger" icon={<Mark icon={Trash} size={16} />}>Delete</Button>
              <Button tone="quiet" icon={<Mark icon={Archive} size={16} />} disabled>Archive</Button>
            </div>
            <Input label="Note title" defaultValue="Moss on the north wall" />
            <Menu>
              <MenuTrigger asChild>
                <Button tone="quiet" icon={<Mark icon={FolderSimple} size={16} />}>Move</Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem>
                  <Mark icon={FolderSimple} size={16} />
                  Field notes
                </MenuItem>
                <MenuItem>
                  <Mark icon={Notebook} size={16} />
                  Reading
                </MenuItem>
                <MenuItem>
                  <Mark icon={Tray} size={16} />
                  Inbox
                </MenuItem>
              </MenuContent>
            </Menu>
            <Modal>
              <ModalTrigger asChild>
                <Button tone="quiet">Rename</Button>
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button tone="quiet" icon={<Mark icon={Info} size={16} />}>About</Button>
              </TooltipTrigger>
              <TooltipContent>Still a draft from this morning.</TooltipContent>
            </Tooltip>
            <Button
              tone="quiet"
              icon={<Mark icon={Check} size={16} />}
              onClick={() => preview.showToast('Saved', 'Moss on the north wall is on this Mac.')}
            >
              Save
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button tone="quiet" icon={<Mark icon={LinkSimple} size={16} />}>Link</Button>
              </PopoverTrigger>
              <PopoverContent>
                <p className="sd-pop-title">Link a note</p>
                <Input label="Title" placeholder="Index of walks" />
              </PopoverContent>
            </Popover>
          </section>

          <Shell />
          <Notice
            open={preview.toastOpen}
            title={preview.toastTitle}
            description={preview.toastBody}
            onOpenChange={(open) => preview.setToastOpen(open)}
          />
        </Toaster>
      </TooltipProvider>
    </DesignLayer>
  )
})

export const ComponentsPage = bindServices(ComponentsPreview, [ComponentsPreviewService])
