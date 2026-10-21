import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Modal, ModalContent, ModalTrigger } from './modal'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

async function mount(children: ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(children)
  })
}

function button(testId: string): HTMLButtonElement {
  return document.querySelector(`[data-testid="${testId}"]`)!
}

function closeButton(): HTMLButtonElement {
  return document.querySelector('.sd-modal-x')!
}

async function finishCloseAutoFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function ProgrammaticModal() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" data-testid="programmatic-open" onClick={() => setOpen(true)}>
        Delete note
      </button>
      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent title="Delete note" description="Delete this note permanently?" />
      </Modal>
    </>
  )
}

function TriggerModal() {
  return (
    <Modal>
      <ModalTrigger asChild>
        <button type="button" data-testid="explicit-trigger">
          Rename note
        </button>
      </ModalTrigger>
      <ModalContent title="Rename note" description="Choose a new name." />
    </Modal>
  )
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  host = null
  document.body.replaceChildren()
})

describe('Modal focus restoration', () => {
  it('restores focus to the invoking button when opened without a Trigger', async () => {
    await mount(<ProgrammaticModal />)
    const opener = button('programmatic-open')
    await act(async () => {
      opener.focus()
      opener.click()
    })
    expect(document.querySelector('.sd-modal')).not.toBeNull()

    await act(async () => {
      closeButton().click()
    })
    await finishCloseAutoFocus()
    expect(document.querySelector('.sd-modal')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps Radix focus restoration for an explicit Trigger', async () => {
    await mount(<TriggerModal />)
    const trigger = button('explicit-trigger')
    await act(async () => {
      trigger.focus()
      trigger.click()
    })
    expect(document.querySelector('.sd-modal')).not.toBeNull()

    await act(async () => {
      closeButton().click()
    })
    await finishCloseAutoFocus()
    expect(document.querySelector('.sd-modal')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
