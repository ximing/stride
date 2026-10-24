// @vitest-environment node
import http from 'node:http'
import fs from 'node:fs'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { runVaultTurn, vaultTools } from './agent.ts'
import { plainText, readNoteFile, saveNote } from './index.ts'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function sse(delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-stride',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

describe('pi-agent vault turn', () => {
  it('reads a note through the real Agent and appends the assistant reply', async () => {
    const seen: { authorization?: string; model?: string; url?: string }[] = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = JSON.parse(raw) as {
          model?: string
          messages?: { role?: string; content?: unknown }[]
        }
        seen.push({
          authorization: req.headers.authorization,
          model: body.model,
          url: req.url,
        })
        const toolMessage = body.messages?.find((message) => message.role === 'tool')
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (!toolMessage) {
          const id = /read note ([A-Za-z0-9_-]+)/.exec(raw)?.[1] ?? 'missing'
          res.write(sse({
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_read',
              type: 'function',
              function: { name: 'read_note', arguments: JSON.stringify({ id }) },
            }],
          }, null))
          res.write(sse({}, 'tool_calls'))
        } else {
          const echoed = JSON.stringify(toolMessage.content)
          res.write(sse({ role: 'assistant', content: `I read: ${echoed}` }, null))
          res.write(sse({}, 'stop'))
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`

    const files = new MemoryFileSystem('/tmp/stride-agent')
    const note = await saveNote(files, {
      id: 'field-note',
      title: 'Field note',
      type: 'note',
      properties: {},
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unique-vault-phrase' }] }],
      },
    })
    let readText = ''
    const tools = vaultTools({
      readNote: async (id) => {
        const loaded = await readNoteFile(files, `${id}.stride.json`, id)
        readText = plainText(loaded.doc)
        return loaded
      },
      searchVault: async () => [],
      writeSerialized: async () => {},
      createNote: async () => note,
      loadNotes: async () => [note],
    })

    const settings = {
      provider: 'stride-fixture',
      model: 'scripted-local',
      baseUrl,
      apiKey: 'sk-stride-chat-key',
    }
    const turn = await runVaultTurn({
      settings,
      history: [],
      userText: `read note ${note.id}`,
      tools,
    })

    expect(turn.model.provider).toBe(settings.provider)
    expect(turn.model.id).toBe(settings.model)
    expect(turn.model.baseUrl).toBe(settings.baseUrl)
    expect(seen[0]?.authorization).toBe(`Bearer ${settings.apiKey}`)
    expect(seen[0]?.model).toBe(settings.model)
    expect(seen[0]?.url?.startsWith('/v1/')).toBe(true)
    expect(readText).toBe('unique-vault-phrase')
    expect(turn.reply).toContain('unique-vault-phrase')
    expect(turn.history.at(-1)).toEqual({ role: 'assistant', text: turn.reply })
    expect(turn.history.some((line) => line.role === 'user')).toBe(true)

    const source = fs.readFileSync(fileURLToPath(new URL('./agent.ts', import.meta.url)), 'utf8')
    const imports = source.split('\n').filter((line) => line.trim().startsWith('import ')).join('\n')
    expect(imports).toContain('@earendil-works/pi-agent-core')
    expect(imports).toContain('@earendil-works/pi-ai')
    expect(imports).not.toMatch(/['"]openai['"]|@anthropic-ai\/sdk|@ai-sdk|langchain|ollama/)
  })
})
