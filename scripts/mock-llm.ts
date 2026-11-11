/**
 * A pretend LLM with an OpenAI-compatible API, for local development and tests.
 * Free, instant, and it can misbehave on purpose.
 *
 *   npm run mock-llm                         # http://127.0.0.1:8787/v1, accepts the key "mock-key"
 *   npm run mock-llm -- --latency 2500       # slow replies
 *   npm run mock-llm -- --fail-rate 0.3      # 30 % of calls fail with HTTP 500
 *   npm run mock-llm -- --host 0.0.0.0       # reachable from other machines
 *
 * Change its behaviour while it runs (scripts/verify-local.ts does this):
 *   curl -X POST 127.0.0.1:8787/__mock/config -d '{"acceptKey":"another-key"}'   # → 401, like a wrong key
 *   curl -X POST 127.0.0.1:8787/__mock/config -d '{"mode":"no_balance"}'          # → 402, like DeepSeek out of credit
 *   curl 127.0.0.1:8787/__mock/stats
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

type Mode = 'ok' | 'no_balance' | 'timeout' | 'empty'

interface MockConfig {
  acceptKey: string
  latencyMs: number
  failRate: number
  mode: Mode
}

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const port = Number(flag('--port', process.env.MOCK_LLM_PORT ?? '8787'))
const host = flag('--host', '127.0.0.1')
const defaults: MockConfig = {
  acceptKey: process.env.MOCK_LLM_KEY ?? 'mock-key',
  latencyMs: Number(flag('--latency', '300')),
  failRate: Number(flag('--fail-rate', '0')),
  mode: 'ok',
}
let config: MockConfig = { ...defaults }
let stats = { requests: 0, byStatus: {} as Record<string, number>, lastRequest: null as unknown }

const MENTION_REPLIES = [
  'Ooh, good question — honestly the chorus decides it for me. What hooked you first?',
  'Ha, I keep going back and forth on that one. Which version do you prefer?',
  'Strong take! I think the production carries it more than the lyrics. Agree?',
]
const SILENCE_REPLIES = [
  'Quick one for everyone: which song would you put on a road-trip playlist right now?',
  'Okay, random question — what was the last song you replayed three times in a row?',
  'Curious: is there an artist you liked before they blew up?',
]
const AI_QUESTION_REPLY = "Ha, I'd rather keep a little mystery! Tell me what you've been listening to instead."

let counter = 0
function replyFor(prompt: string): string {
  counter += 1
  // Only the message that mentioned the bot counts (not the whole transcript).
  const mention = /mentioned you in: "([\s\S]*?)"\. Reply to them\./.exec(prompt)
  if (!mention) return SILENCE_REPLIES[counter % SILENCE_REPLIES.length] as string
  if (/are you (an? )?(ai|bot|robot|real)/i.test(mention[1] ?? '')) return AI_QUESTION_REPLY
  return MENTION_REPLIES[counter % MENTION_REPLIES.length] as string
}

function send(res: ServerResponse, status: number, body: unknown): void {
  stats = { ...stats, byStatus: { ...stats.byStatus, [status]: (stats.byStatus[status] ?? 0) + 1 } }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  return raw ? JSON.parse(raw) : {}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function chatCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
  stats = { ...stats, requests: stats.requests + 1 }
  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${config.acceptKey}`) {
    send(res, 401, { error: { message: 'Authentication Fails (invalid API key)', type: 'authentication_error' } })
    return
  }
  if (config.mode === 'no_balance') {
    send(res, 402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } })
    return
  }
  if (config.mode === 'timeout') {
    await sleep(60_000) // the caller gives up long before this
    send(res, 504, { error: { message: 'too slow' } })
    return
  }
  if (Math.random() < config.failRate) {
    send(res, 500, { error: { message: 'Mock server error' } })
    return
  }

  const body = (await readJson(req)) as {
    model?: string
    messages?: { role: string; content: string }[]
    max_tokens?: number
    thinking?: unknown
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    send(res, 400, { error: { message: 'messages is required' } })
    return
  }
  stats = { ...stats, lastRequest: { model: body.model, max_tokens: body.max_tokens, thinking: body.thinking ?? null, messages: body.messages.length } }
  await sleep(config.latencyMs)

  const prompt = body.messages.map((m) => m.content).join('\n')
  const content = config.mode === 'empty' ? '' : replyFor(prompt)
  const promptTokens = Math.ceil(prompt.length / 4)
  const completionTokens = Math.ceil(content.length / 4)
  send(res, 200, {
    id: `mock-${Date.now()}-${counter}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'mock-chat',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  })
}

async function updateConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const patch = (await readJson(req)) as Partial<MockConfig> & { reset?: boolean }
  const next: MockConfig = patch.reset ? { ...defaults } : { ...config }
  if (typeof patch.acceptKey === 'string') next.acceptKey = patch.acceptKey
  if (typeof patch.latencyMs === 'number') next.latencyMs = patch.latencyMs
  if (typeof patch.failRate === 'number') next.failRate = patch.failRate
  if (patch.mode && ['ok', 'no_balance', 'timeout', 'empty'].includes(patch.mode)) next.mode = patch.mode
  config = next
  send(res, 200, { ok: true, mode: config.mode, latencyMs: config.latencyMs, failRate: config.failRate })
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  const route = `${req.method} ${path}`
  const handle = async (): Promise<void> => {
    if (route === 'POST /v1/chat/completions' || route === 'POST /chat/completions') return chatCompletion(req, res)
    if (route === 'GET /v1/models' || route === 'GET /models') return send(res, 200, { data: [{ id: 'mock-chat', object: 'model' }] })
    if (route === 'GET /health') return send(res, 200, { ok: true })
    if (route === 'GET /__mock/stats') return send(res, 200, { ...stats, mode: config.mode, latencyMs: config.latencyMs })
    if (route === 'POST /__mock/config') return updateConfig(req, res)
    if (route === 'POST /__mock/reset') {
      stats = { requests: 0, byStatus: {}, lastRequest: null }
      return send(res, 200, { ok: true })
    }
    send(res, 404, { error: { message: `No route ${route}` } })
  }
  handle().catch((error: unknown) => send(res, 500, { error: { message: error instanceof Error ? error.message : 'mock error' } }))
})

server.listen(port, host, () => {
  process.stdout.write(`Mock LLM listening on http://${host}:${port}/v1 (accepts key "${defaults.acceptKey}")\n`)
  process.stdout.write('From the Supabase Edge runtime (Docker) use LLM_BASE_URL=http://host.docker.internal:8787/v1\n')
})
