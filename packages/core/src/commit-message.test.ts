import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, Model, StopReason } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'
import { suggestCommitMessage } from './commit-message.ts'

const usage = {
  input: 3,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const model = {
  id: 'gpt-4o-mini',
  name: 'gpt-4o-mini',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} as Model<'openai-completions'>

function assistant(
  text: string,
  stopReason: StopReason = 'stop',
  content?: AssistantMessage['content'],
): AssistantMessage {
  return {
    role: 'assistant',
    content: content ?? [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o-mini',
    stopReason,
    timestamp: Date.now(),
    usage,
  }
}

function textStream(parts: string[]): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => {
      let text = ''
      stream.push({ type: 'start', partial: assistant('') })
      for (const part of parts) {
        text += part
        stream.push({ type: 'text_delta', contentIndex: 0, delta: part, partial: assistant(text) })
      }
      const done = assistant(text)
      stream.push({ type: 'done', reason: 'stop', message: done })
      stream.end(done)
    })
    return stream
  }
}

describe('suggestCommitMessage', () => {
  it('returns the subject emitted for the diff', async () => {
    const result = await suggestCommitMessage({
      diff: 'fix the title',
      model,
      apiKey: 'sk-passed',
      streamFn: textStream(['fix: rename the note']),
    })
    expect(result).toEqual({
      message: 'fix: rename the note',
      aborted: false,
      usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, costTotal: 0 },
    })
  })

  it('does not call streamFn for an empty diff', async () => {
    let calls = 0
    const streamFn: StreamFn = () => {
      calls += 1
      return textStream(['fix: rename the note'])()
    }
    const empty = await suggestCommitMessage({
      diff: '',
      model,
      apiKey: 'sk-passed',
      streamFn,
    })
    const blank = await suggestCommitMessage({
      diff: ' \n\t',
      model,
      apiKey: 'sk-passed',
      streamFn,
    })
    expect(calls).toBe(0)
    expect(empty).toEqual({ message: '', aborted: false })
    expect(blank).toEqual({ message: '', aborted: false })
  })

  it('redacts the api key from the subject', async () => {
    const result = await suggestCommitMessage({
      diff: 'fix the title',
      model,
      apiKey: 'sk-passed',
      streamFn: textStream(['sk-passed']),
    })
    expect(result.message.includes('••••')).toBe(true)
    expect(result.message.includes('sk-passed')).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('returns aborted when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await suggestCommitMessage({
      diff: 'fix the title',
      model,
      apiKey: 'sk-passed',
      streamFn: textStream(['fix: rename the note']),
      signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
  })
})
