import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'
import {
  newSessionId,
  parseSession,
  parseSessionMeta,
  serializeSession,
  serializeSessionMeta,
  sessionTitleFromText,
  stripSystemMessages,
  truncateTranscript,
  vaultStorageKey,
  TRUNCATED_MARK,
  type ChatSessionFile,
  type ChatSessionMeta,
} from './chat-session.ts'

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costTotal: 0 }

function metaFixture(): ChatSessionMeta {
  return {
    format: 1,
    id: 'ses_1',
    vaultKey: '9f2c1ab8e04d77c3',
    vaultLabel: 'work-notes',
    title: '修复提交检查',
    createdAt: '2026-11-06T08:00:00.000Z',
    updatedAt: '2026-11-06T08:12:31.000Z',
    status: 'active',
    modelId: 'cfg_zhipu_flash',
    messageCount: 2,
    usage,
  }
}

function userMessage(text: string, timestamp = 1): AgentMessage {
  return { role: 'user', content: text, timestamp }
}

function toolResult(text: string, timestamp = 2): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'read_note',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  }
}

function systemMessage(): AgentMessage {
  return { role: 'system', content: 'prompt', timestamp: 0 }
}

function fileFixture(): ChatSessionFile {
  return {
    format: 1,
    id: 'ses_1',
    messages: [
      { id: 'msg_1', role: 'user', text: '提交检查拦住了这个仓库', thinking: '', ts: '2026-11-06T08:00:01.000Z', tools: [] },
      {
        id: 'msg_2',
        role: 'assistant',
        text: '我来修复',
        thinking: '…',
        ts: '2026-11-06T08:00:05.000Z',
        tools: [{
          id: 'call_1',
          name: 'read_note',
          argsSummary: '{"id":"agents/review/x"}',
          resultSummary: 'ok',
          durationMs: 93,
          isError: false,
          pending: false,
        }],
      },
    ],
    transcript: [userMessage('提交检查拦住了这个仓库'), toolResult('note body')],
    memory: { distilledUpTo: 2, lastDistillAt: '2026-11-06T08:15:00.000Z' },
  }
}

describe('newSessionId', () => {
  it('uses the ses_ prefix and generates unique ids', () => {
    const first = newSessionId()
    const second = newSessionId()
    expect(first.startsWith('ses_')).toBe(true)
    expect(first).not.toBe(second)
  })
})

describe('session meta serialization', () => {
  it('round-trips a meta file', () => {
    const meta = metaFixture()
    expect(parseSessionMeta(serializeSessionMeta(meta))).toEqual(meta)
  })

  it('returns null for bad JSON and the wrong format', () => {
    expect(parseSessionMeta('not json')).toBeNull()
    expect(parseSessionMeta('[]')).toBeNull()
    expect(parseSessionMeta(JSON.stringify({ ...metaFixture(), format: 2 }))).toBeNull()
    expect(parseSessionMeta(JSON.stringify({ format: 1 }))).toBeNull()
  })

  it('normalizes missing fields to defaults', () => {
    const parsed = parseSessionMeta(JSON.stringify({ format: 1, id: 'ses_1' }))
    expect(parsed).toEqual({
      format: 1,
      id: 'ses_1',
      vaultKey: '',
      vaultLabel: '',
      title: '',
      createdAt: '',
      updatedAt: '',
      status: 'active',
      modelId: '',
      messageCount: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 },
    })
  })
})

describe('session file serialization', () => {
  it('round-trips a session file', () => {
    const file = fileFixture()
    expect(parseSession(serializeSession(file))).toEqual(file)
  })

  it('returns null for bad JSON, the wrong format, or a missing id', () => {
    expect(parseSession('not json')).toBeNull()
    expect(parseSession('42')).toBeNull()
    expect(parseSession(JSON.stringify({ ...fileFixture(), format: 2 }))).toBeNull()
    expect(parseSession(JSON.stringify({ format: 1, messages: [] }))).toBeNull()
  })

  it('normalizes defaults and drops malformed messages', () => {
    const parsed = parseSession(JSON.stringify({
      format: 1,
      id: 'ses_1',
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'system', text: 'nope' },
        'garbage',
      ],
    }))
    expect(parsed).not.toBeNull()
    expect(parsed?.messages).toEqual([{ id: '', role: 'user', text: 'hi', thinking: '', ts: '', tools: [] }])
    expect(parsed?.transcript).toEqual([])
    expect(parsed?.memory).toEqual({ distilledUpTo: 0, lastDistillAt: '' })
  })

  it('strips system messages from a stored transcript', () => {
    const file = fileFixture()
    file.transcript = [systemMessage(), userMessage('hi')]
    const parsed = parseSession(serializeSession(file))
    expect(parsed?.transcript.map((message) => message.role)).toEqual(['user'])
  })
})

describe('stripSystemMessages', () => {
  it('drops system messages and keeps the order of the rest', () => {
    const messages: AgentMessage[] = [systemMessage(), userMessage('a'), toolResult('b'), userMessage('c', 3)]
    expect(stripSystemMessages(messages).map((message) => message.role)).toEqual(['user', 'toolResult', 'user'])
  })
})

describe('truncateTranscript', () => {
  it('truncates an oversized tool result text and marks it', () => {
    const long = 'x'.repeat(9000)
    const result = truncateTranscript([toolResult(long)])
    const message = result[0]
    expect(message?.role).toBe('toolResult')
    if (message?.role !== 'toolResult') return
    const part = message.content[0]
    expect(part?.type).toBe('text')
    if (part?.type !== 'text') return
    expect(part.text.length).toBe(8192 + TRUNCATED_MARK.length + 1)
    expect(part.text.startsWith('x'.repeat(100))).toBe(true)
    expect(part.text.endsWith(TRUNCATED_MARK)).toBe(true)
  })

  it('honours a custom limit and leaves short content untouched', () => {
    const short = toolResult('abc')
    const result = truncateTranscript([short], 10)
    expect(result[0]).toBe(short)
    const long = toolResult('a'.repeat(20))
    const truncated = truncateTranscript([long], 10)[0]
    if (truncated?.role !== 'toolResult') throw new Error('expected toolResult')
    const part = truncated.content[0]
    if (part?.type !== 'text') throw new Error('expected text part')
    expect(part.text).toBe(`aaaaaaaaaa\n${TRUNCATED_MARK}`)
  })

  it('does not touch other messages or non-text parts', () => {
    const user = userMessage('u'.repeat(9000))
    const withImage: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'call_2',
      toolName: 'screenshot',
      content: [{ type: 'image', data: 'a'.repeat(9000), mimeType: 'image/png' }],
      isError: false,
      timestamp: 4,
    }
    const result = truncateTranscript([user, withImage])
    expect(result[0]).toBe(user)
    expect(result[1]).toBe(withImage)
  })
})

describe('sessionTitleFromText', () => {
  it('normalizes whitespace and caps at 24 characters', () => {
    expect(sessionTitleFromText('  修复  提交\n检查  ')).toBe('修复 提交 检查')
    expect(sessionTitleFromText('a'.repeat(40))).toBe('a'.repeat(24))
    expect(sessionTitleFromText('   ')).toBe('')
  })
})

describe('vaultStorageKey', () => {
  it('is stable, 16 lowercase hex chars, and id-dependent', () => {
    const key = vaultStorageKey('vault-/Users/x/notes')
    expect(key).toBe(vaultStorageKey('vault-/Users/x/notes'))
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(key).not.toBe(vaultStorageKey('vault-/Users/y/notes'))
    // Known SHA-256 vector keeps the derivation pinned.
    expect(vaultStorageKey('')).toBe('e3b0c44298fc1c14')
  })
})
