// Fake stdio peer for Grok ACP, Claude stream-json, and Codex app-server.
// The shipped client spawns this process in tests. It is not a second protocol implementation
// of the client: it only answers the frames the real client writes.
// Prompt text "activity" emits tool rows and, for Codex, the approval requests the client must answer.
import { createInterface } from 'node:readline'

const command = process.argv[2]
let prompts = 0
let grokPromptId = null
const waiters = new Map()

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function replyFor(text) {
  if (text === 'hang') return ''
  prompts += 1
  return prompts === 1 ? 'alpha' : 'beta'
}

function rejectModel(message) {
  const blob = JSON.stringify(message)
  if (blob.includes('session/set_model') || blob.includes('--model') || blob.includes('"modelId"')) {
    process.exit(3)
  }
  if (message.params && typeof message.params === 'object') {
    if (Object.prototype.hasOwnProperty.call(message.params, 'model')) process.exit(3)
    if (Object.prototype.hasOwnProperty.call(message.params, 'modelId')) process.exit(3)
  }
}

function roundTrip(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(message.id)
      reject(new Error(`timed out waiting for ${message.id}`))
    }, 4000)
    waiters.set(message.id, (response) => {
      clearTimeout(timer)
      resolve(response)
    })
    send(message)
  })
}

function noteResponse(message) {
  if (message.id == null || message.method != null) return false
  const waiter = waiters.get(message.id)
  if (waiter) {
    waiters.delete(message.id)
    waiter(message)
  }
  return true
}

if (process.env.PEER_MODE === 'fail-handshake') process.exit(1)

if (command === 'claude') {
  if (process.env.PEER_RESUME === 'exit') process.exit(1)
  send({ type: 'system', subtype: 'init', session_id: 'claude-session' })
  let pending = ''
  let pendingUser = ''
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    rejectModel(message)
    if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
      if (process.env.PEER_CANCEL === 'exit') {
        process.exit(0)
        return
      }
      send({
        type: 'control_response',
        response: { subtype: 'interrupt', request_id: message.request_id },
      })
      send({ type: 'result', subtype: 'success', session_id: 'claude-session', result: '', is_error: false })
      return
    }
    if (message.type === 'control_response') {
      if (!pending) return
      const replyText = pending
      const user = pendingUser
      pending = ''
      pendingUser = ''
      if (user === 'activity') {
        sendClaudeActivity(replyText)
        return
      }
      send({
        type: 'assistant',
        session_id: 'claude-session',
        message: { role: 'assistant', content: [{ type: 'text', text: replyText }] },
      })
      send({ type: 'result', subtype: 'success', session_id: 'claude-session', result: replyText })
      return
    }
    const text = message?.message?.content?.[0]?.text ?? ''
    const reply = replyFor(text)
    if (!reply) return
    pending = reply
    pendingUser = text
    send({
      type: 'control_request',
      request_id: `req-${prompts}`,
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'true' } },
    })
  })
} else if (command === 'codex' || command === 'grok') {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    rejectModel(message)
    if (noteResponse(message)) return
    const id = message.id
    const method = message.method
    if (method === 'initialized') return
    if (command === 'codex' && method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { userAgent: 'codex-fake' } })
      return
    }
    if (command === 'codex' && method === 'thread/start') {
      send({ jsonrpc: '2.0', id, result: { thread: { id: 'thread-1' } } })
      return
    }
    if (command === 'codex' && method === 'thread/resume') {
      if (process.env.PEER_RESUME === 'exit') {
        process.exit(1)
        return
      }
      if (process.env.PEER_RESUME === 'fail') {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'no such thread' } })
        return
      }
      const threadId = typeof message.params?.threadId === 'string' ? message.params.threadId : 'thread-1'
      send({ jsonrpc: '2.0', id, result: { thread: { id: threadId } } })
      return
    }
    if (command === 'codex' && method === 'turn/interrupt') {
      if (process.env.PEER_CANCEL === 'exit') {
        process.exit(0)
        return
      }
      if (process.env.PEER_CANCEL === 'missing') {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
        return
      }
      send({ jsonrpc: '2.0', id, result: {} })
      send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId: message.params?.threadId ?? 'thread-1',
          turn: { status: 'completed', items: [] },
        },
      })
      return
    }
    if (command === 'codex' && method === 'turn/start') {
      const text = message.params?.input?.[0]?.text ?? ''
      const reply = replyFor(text)
      const promptIndex = prompts
      send({ jsonrpc: '2.0', id, result: { turn: { id: `turn-${promptIndex}`, status: 'inProgress', items: [] } } })
      if (!reply) return
      if (text === 'activity') {
        void runCodexActivity(reply, promptIndex)
        return
      }
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { id: `item-${promptIndex}`, type: 'agentMessage', text: reply } },
      })
      send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { status: 'completed', items: [{ id: `final-${promptIndex}`, type: 'agentMessage', text: reply }] },
        },
      })
      return
    }
    if (command === 'grok' && method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: { authMethods: [{ id: 'cached_token' }], agentCapabilities: {} },
      })
      return
    }
    if (command === 'grok' && method === 'authenticate') {
      send({ jsonrpc: '2.0', id, result: {} })
      return
    }
    if (command === 'grok' && method === 'session/new') {
      send({ jsonrpc: '2.0', id, result: { sessionId: 'grok-session' } })
      return
    }
    if (command === 'grok' && (method === 'session/cancel' || method === '$/cancel_request')) {
      if (process.env.PEER_CANCEL === 'exit') {
        process.exit(0)
        return
      }
      if (process.env.PEER_CANCEL === 'missing') {
        send({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } })
        return
      }
      const requestId = method === '$/cancel_request' ? message.params?.requestId : grokPromptId
      if (requestId == null) return
      send({ jsonrpc: '2.0', id: requestId, error: { code: -32800, message: 'Request cancelled' } })
      grokPromptId = null
      return
    }
    if (command === 'grok' && method === 'session/prompt') {
      grokPromptId = id
      const text = message.params?.prompt?.[0]?.text ?? ''
      const reply = replyFor(text)
      if (!reply) return
      if (text === 'activity') sendGrokActivity(reply)
      else {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } },
        })
      }
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
      grokPromptId = null
    }
  })
} else {
  process.exit(2)
}

function sendClaudeActivity(replyText) {
  send({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'partial-tool', name: 'Bash', input: { command: 'echo hi' } },
    },
  })
  send({
    type: 'assistant',
    session_id: 'claude-session',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: replyText },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'notes/a.stride.json' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'false' } },
      ],
    },
  })
  send({
    type: 'user',
    session_id: 'claude-session',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'note body' }], is_error: false },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'nope', is_error: true },
      ],
    },
  })
  send({ type: 'result', subtype: 'success', session_id: 'claude-session', result: replyText, is_error: false })
}

function sendGrokActivity(reply) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'secret-thought' } } },
  })
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update: { sessionUpdate: 'plan', entries: [{ content: 'do the thing' }] } },
  })
  send({ jsonrpc: '2.0', method: 'x.ai/fs_notify', params: { path: 'secret.stride.json' } })
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update: { sessionUpdate: 'x.ai/fs_notify', path: 'secret.stride.json' } },
  })
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read file',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'a.stride.json' },
      },
    },
  })
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update: { sessionUpdate: 'tool_call', kind: 'search' } },
  })
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'failed',
        rawOutput: { lines: 2 },
        content: [{ type: 'text', text: 'boom' }],
      },
    },
  })
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } },
  })
}

async function runCodexActivity(reply, promptIndex) {
  try {
    await roundTrip({
      jsonrpc: '2.0',
      id: 9001,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'cmd-1' },
    })
    await roundTrip({
      jsonrpc: '2.0',
      id: 'file-approval',
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'file-1' },
    })
    await roundTrip({
      jsonrpc: '2.0',
      id: 9003,
      method: 'mcpServer/elicitation/request',
      params: { message: 'choose' },
    })
    send({
      jsonrpc: '2.0',
      id: 9004,
      method: 'item/permissions/requestApproval',
      params: {
        cwd: '/vault',
        itemId: 'perm-1',
        permissions: { fileSystem: { read: ['/etc'] }, network: { enabled: true } },
        startedAtMs: 1,
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    })
    await roundTrip({
      jsonrpc: '2.0',
      id: 9005,
      method: `custom/${'n'.repeat(70)}`,
      params: { hello: true },
    })
    const commandOutput = `HEAD${'y'.repeat(4000)}TAILMARK`
    send({
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'ls',
          cwd: '/vault',
          status: 'inProgress',
          commandActions: [],
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'ls',
          cwd: '/vault',
          status: 'inProgress',
          commandActions: [],
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'ls',
          cwd: '/vault',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: commandOutput,
          commandActions: [],
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-deny',
          type: 'commandExecution',
          command: 'rm -rf /',
          cwd: '/vault',
          status: 'declined',
          commandActions: [],
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          id: 'file-1',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: 'readme.md', kind: { type: 'update' }, diff: 'D'.repeat(250) },
            { path: 'notes/a.stride.json', kind: { type: 'add' }, diff: 'note-diff' },
          ],
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          id: 'file-2',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'notes/a.stride.json', kind: { type: 'update' }, diff: 'hello-note' }],
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          server: 'vault',
          tool: 'search',
          arguments: { q: 'moss' },
          status: 'completed',
          result: { content: [{ text: 'found' }] },
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          id: 'mcp-err',
          type: 'mcpToolCall',
          server: 'vault',
          tool: 'broken',
          arguments: {},
          status: 'failed',
          error: { message: 'nope' },
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { item: { id: 'web-1', type: 'webSearch', query: 'stride notes', status: 'completed' } },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { item: { id: 'reason-1', type: 'reasoning', summary: ['secret-thought'] } },
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { item: { id: `item-${promptIndex}`, type: 'agentMessage', text: reply } },
    })
    send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { status: 'completed', items: [{ id: `final-${promptIndex}`, type: 'agentMessage', text: reply }] },
      },
    })
  } catch (error) {
    send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { status: 'failed', error: String(error), items: [] } },
    })
  }
}
