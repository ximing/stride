import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { runAgentLoop } from './agent-loop.ts'
import { redactSecret } from './llm.ts'

const DIFF_LIMIT = 8000
const SUBJECT_LIMIT = 72

const SYSTEM_PROMPT = 'Write one commit subject line. Do not use a markdown fence. Do not include an explanation.'

function subjectLine(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? ''
  return line.slice(0, SUBJECT_LIMIT)
}

export async function suggestCommitMessage(input: {
  diff: string
  model: Model<Api>
  apiKey: string
  streamFn: StreamFn
  signal?: AbortSignal
}): Promise<{ message: string; aborted: boolean }> {
  if (!input.diff.trim()) return { message: '', aborted: false }
  const result = await runAgentLoop({
    model: input.model,
    apiKey: input.apiKey,
    systemPrompt: SYSTEM_PROMPT,
    prompt: input.diff.slice(0, DIFF_LIMIT),
    tools: [],
    maxTurns: 1,
    signal: input.signal,
    streamFn: input.streamFn,
  })
  return {
    message: subjectLine(redactSecret(result.text, input.apiKey)),
    aborted: result.aborted,
  }
}
