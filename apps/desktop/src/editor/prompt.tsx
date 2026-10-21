import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, IconButton } from '../ui/button'
import { useLayer } from '../ui/layer'
import { Modal, ModalClose } from '../ui/modal'

export function EditorPrompt({
  title,
  description,
  label,
  initialValue,
  placeholder,
  extraLabel,
  inputTestId = 'link-href',
  extraTestId = 'link-unset',
  onSubmit,
  onExtra,
  onClose,
}: {
  title: string
  description: string
  label: string
  initialValue: string
  placeholder?: string
  extraLabel?: string
  inputTestId?: string
  extraTestId?: string
  onSubmit: (value: string) => void
  onExtra?: () => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const layer = useLayer()

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit(value)
  }

  function focusInput() {
    inputRef.current?.focus()
    inputRef.current?.select()
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal container={layer ?? undefined}>
        <Dialog.Overlay className="sd-overlay editor-prompt-backdrop" />
        <Dialog.Content
          asChild
          className="sd-modal"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            focusInput()
          }}
        >
          <form className="editor-prompt" onSubmit={submit}>
            <Dialog.Title className="sd-modal-title editor-prompt-title">{title}</Dialog.Title>
            <Dialog.Description className="sd-modal-copy editor-prompt-copy">{description}</Dialog.Description>
            <input
              ref={inputRef}
              className="editor-prompt-input"
              data-testid={inputTestId}
              aria-label={label}
              value={value}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setValue(event.target.value)}
            />
            <div className="editor-prompt-actions">
              {extraLabel ? (
                <Button
                  tone="danger"
                  className="editor-prompt-extra"
                  data-testid={extraTestId}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onExtra}
                >
                  {extraLabel}
                </Button>
              ) : null}
              <ModalClose asChild>
                <Button tone="secondary" className="editor-prompt-cancel">取消</Button>
              </ModalClose>
              <Button tone="primary" className="editor-prompt-submit" type="submit">应用</Button>
            </div>
            <ModalClose asChild>
              <IconButton className="sd-modal-x" icon={X} label="Close" />
            </ModalClose>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Modal>
  )
}

export function PromptHost({ children }: { children: ReactNode }) {
  return children
}
