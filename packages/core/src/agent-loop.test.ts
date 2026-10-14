import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { Type, type AssistantMessage, type Model, type StopReason } from '@earendil-works/pi-ai'
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'
import { runAgentLoop, type AgentLoopEvent } from './agent-loop.ts'

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

describe('runAgentLoop', () => {
  it('joins text deltas, records usage, and passes the caller key', async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-env-not-used'
    const events: AgentLoopEvent[] = []
    let seenKey = ''
    const streamFn: StreamFn = (calledModel, context, options) => {
      seenKey = options?.apiKey ?? ''
      expect(calledModel.id).toBe('gpt-4o-mini')
      expect(context).toBeTruthy()
      return textStream(['hel', 'lo'])(calledModel, context, options)
    }
    try {
      const result = await runAgentLoop({
        model,
        apiKey: 'sk-passed',
        systemPrompt: 'test',
        prompt: 'go',
        streamFn,
        onEvent: (event) => events.push(event),
      })
      expect(seenKey).toBe('sk-passed')
      expect(seenKey).not.toBe(process.env.OPENAI_API_KEY)
      expect(result.text).toBe('hello')
      expect(result.aborted).toBe(false)
      expect(result.usage).toEqual({
        input: 3,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        costTotal: 0,
      })
      expect(events.filter((event) => event.type === 'text_delta').map((event) => event.type === 'text_delta' ? event.delta : '')).toEqual(['hel', 'lo'])
      expect(events.some((event) => event.type === 'usage' && event.usage.output === 2)).toBe(true)
      expect(events.at(-1)).toMatchObject({ type: 'done', text: 'hello', aborted: false })
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  it('aborts on the first text delta and does not call the model again', async () => {
    const controller = new AbortController()
    let calls = 0
    const streamFn: StreamFn = () => {
      calls += 1
      const stream = createAssistantMessageEventStream()
      queueMicrotask(() => {
        void (async () => {
          try {
            stream.push({ type: 'start', partial: assistant('') })
            stream.push({ type: 'text_delta', contentIndex: 0, delta: 'hel', partial: assistant('hel') })
            await new Promise((resolve) => setTimeout(resolve, 40))
            if (controller.signal.aborted) {
              const error = assistant('', 'aborted')
              stream.push({ type: 'error', reason: 'aborted', error })
              stream.end(error)
              return
            }
            const done = assistant('hello')
            stream.push({ type: 'text_delta', contentIndex: 0, delta: 'lo', partial: done })
            stream.push({ type: 'done', reason: 'stop', message: done })
            stream.end(done)
          } catch {
            // The agent may close the stream when abort lands.
          }
        })()
      })
      return stream
    }
    const result = await runAgentLoop({
      model,
      apiKey: 'sk-passed',
      systemPrompt: 'test',
      prompt: 'go',
      signal: controller.signal,
      streamFn,
      onEvent: (event) => {
        if (event.type === 'text_delta') controller.abort()
      },
    })
    expect(calls).toBe(1)
    expect(result.aborted).toBe(true)
  })

  it('stops after one tool turn when maxTurns is 1 and redacts the key', async () => {
    let calls = 0
    const events: AgentLoopEvent[] = []
    const toolCall = { type: 'toolCall' as const, id: 'call_1', name: 'ping', arguments: { q: 'a' } }
    const ping: AgentTool = {
      name: 'ping',
      label: 'Ping',
      description: 'ping',
      parameters: Type.Object({ q: Type.String() }),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'tool-ok sk-passed' }],
        details: null,
      }),
    }
    const streamFn: StreamFn = () => {
      calls += 1
      const stream = createAssistantMessageEventStream()
      queueMicrotask(() => {
        if (calls === 1) {
          const partial = assistant('', 'toolUse', [toolCall])
          stream.push({ type: 'start', partial })
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial })
          stream.push({ type: 'done', reason: 'toolUse', message: partial })
          stream.end(partial)
          return
        }
        const done = assistant('after')
        stream.push({ type: 'start', partial: assistant('') })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'after', partial: done })
        stream.push({ type: 'done', reason: 'stop', message: done })
        stream.end(done)
      })
      return stream
    }
    const result = await runAgentLoop({
      model,
      apiKey: 'sk-passed',
      systemPrompt: 'test',
      prompt: 'go',
      tools: [ping],
      maxTurns: 1,
      streamFn,
      onEvent: (event) => events.push(event),
    })
    expect(calls).toBe(1)
    const toolEnd = events.find((event) => event.type === 'tool_end')
    expect(toolEnd).toMatchObject({ type: 'tool_end', name: 'ping', toolCallId: 'call_1', isError: false })
    if (toolEnd?.type === 'tool_end') {
      expect(toolEnd.resultSummary.includes('sk-passed')).toBe(false)
      expect(toolEnd.resultSummary.includes('••••')).toBe(true)
      expect(toolEnd.resultSummary.length).toBeLessThanOrEqual(200)
    }
    expect(result.aborted).toBe(false)
  })
})
