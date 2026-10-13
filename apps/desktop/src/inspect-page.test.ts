import { describe, expect, it } from 'vitest'
import { runPageCommand } from './inspect-page'

describe('inspect page commands', () => {
  it('names controls, clicks by ref, and fills a controlled input', async () => {
    document.body.innerHTML = `
      <label><span>Vault folder</span><input id="path" value="" /></label>
      <button type="submit" id="open">Open vault</button>
      <div id="editor" contenteditable="true"></div>
    `
    let clicks = 0
    document.getElementById('open')!.addEventListener('click', () => {
      clicks += 1
    })
    const shot = await runPageCommand('snapshot') as { tree: string }
    expect(shot.tree).toContain('textbox "Vault folder"')
    expect(shot.tree).toContain('button "Open vault"')
    const button = /button "Open vault".*\[ref=(@e\d+)\]/.exec(shot.tree)
    const field = /textbox "Vault folder".*\[ref=(@e\d+)\]/.exec(shot.tree)
    expect(button?.[1]).toBeTruthy()
    await runPageCommand('click', { selector: button![1] })
    expect(clicks).toBe(1)
    await runPageCommand('fill', { selector: field![1], value: '/tmp/notes' })
    expect((document.getElementById('path') as HTMLInputElement).value).toBe('/tmp/notes')
    const editorRef = /textbox "".*\[ref=(@e\d+)\]/.exec(shot.tree)?.[1]
    expect(editorRef).toBeTruthy()
    await runPageCommand('fill', { selector: editorRef!, value: 'local first' })
    expect(document.getElementById('editor')!.textContent).toBe('local first')
    await expect(runPageCommand('click', { selector: '@e99' })).rejects.toThrow(/unknown ref/)
    const waited = await runPageCommand('wait', { text: 'Open vault', timeout_ms: 200 })
    expect(waited).toEqual({ found: true })
  })
})
