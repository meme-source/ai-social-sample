/**
 * One call to any OpenAI-compatible Chat Completions API (DeepSeek by default).
 * Switching provider = changing the LLM_* secrets; no code change.
 *
 * Never throws: every failure becomes an error code the caller can log and
 * answer with a question-bank fallback.
 */
import type { LlmChatMessage } from './reply.ts'

export interface LlmConfig {
  baseUrl: string
  model: string
  apiKey: string
  provider: string
  timeoutMs: number
  maxTokens: number
  temperature: number
  extraBody: Record<string, unknown>
  warning: string | null
}

export type LlmErrorCode =
  | 'not_configured' // no LLM_API_KEY secret
  | 'auth' // wrong key (401/403)
  | 'no_balance' // DeepSeek answers 402 when the account is out of credit
  | 'rate_limited' // 429
  | 'bad_request' // 400/422, e.g. a parameter the provider does not accept
  | 'not_found' // 404, usually a wrong base URL or model name
  | 'server_error' // 5xx
  | 'timeout'
  | 'network'
  | 'empty_reply'
  | 'bad_response'

export type LlmResult =
  | { ok: true; text: string; latencyMs: number; promptTokens: number | null; completionTokens: number | null }
  | { ok: false; errorCode: LlmErrorCode; status: number | null; latencyMs: number }

export const LLM_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  timeoutMs: 8_000, // must stay well under the 15 s room lock
  maxTokens: 120, // two short sentences
  temperature: 0.8,
} as const

/** DeepSeek models think before answering unless told not to; chat replies should be instant. */
const DEEPSEEK_NON_THINKING = { thinking: { type: 'disabled' } }

const clampInt = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'invalid-url'
  }
}

/** Read the LLM_* settings. `get` is Deno.env.get in the Edge Function. */
export function resolveLlmConfig(get: (name: string) => string | undefined): LlmConfig {
  const baseUrl = (get('LLM_BASE_URL')?.trim() || LLM_DEFAULTS.baseUrl).replace(/\/+$/, '')
  const provider = hostnameOf(baseUrl)
  let extraBody: Record<string, unknown> = provider.endsWith('deepseek.com') ? DEEPSEEK_NON_THINKING : {}
  let warning: string | null = null

  const rawExtra = get('LLM_EXTRA_BODY')?.trim()
  if (rawExtra) {
    try {
      const parsed: unknown = JSON.parse(rawExtra)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      extraBody = parsed as Record<string, unknown>
    } catch {
      warning = 'LLM_EXTRA_BODY is not a JSON object; ignored'
    }
  }

  return {
    baseUrl,
    model: get('LLM_MODEL')?.trim() || LLM_DEFAULTS.model,
    apiKey: get('LLM_API_KEY')?.trim() ?? '',
    provider,
    timeoutMs: clampInt(get('LLM_TIMEOUT_MS'), LLM_DEFAULTS.timeoutMs, 1_000, 12_000),
    maxTokens: clampInt(get('LLM_MAX_TOKENS'), LLM_DEFAULTS.maxTokens, 16, 400),
    temperature: LLM_DEFAULTS.temperature,
    extraBody,
    warning,
  }
}

export function classifyStatus(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'no_balance'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 422) return 'bad_request'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server_error'
  return 'bad_response'
}

const tokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export async function callChatCompletion(
  config: LlmConfig,
  messages: readonly LlmChatMessage[],
  fetchImpl: FetchLike = fetch,
  now: () => number = () => performance.now(),
): Promise<LlmResult> {
  const started = now()
  const elapsed = (): number => Math.round(now() - started)
  if (!config.apiKey) return { ok: false, errorCode: 'not_configured', status: null, latencyMs: 0 }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        ...config.extraBody,
        model: config.model,
        messages,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        stream: false,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, errorCode: classifyStatus(response.status), status: response.status, latencyMs: elapsed() }
    }

    let json: {
      choices?: { message?: { content?: unknown } }[]
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
    }
    try {
      json = await response.json()
    } catch {
      const errorCode: LlmErrorCode = controller.signal.aborted ? 'timeout' : 'bad_response'
      return { ok: false, errorCode, status: response.status, latencyMs: elapsed() }
    }
    const text = json.choices?.[0]?.message?.content
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, errorCode: 'empty_reply', status: response.status, latencyMs: elapsed() }
    }
    return {
      ok: true,
      text,
      latencyMs: elapsed(),
      promptTokens: tokenCount(json.usage?.prompt_tokens),
      completionTokens: tokenCount(json.usage?.completion_tokens),
    }
  } catch {
    const errorCode: LlmErrorCode = controller.signal.aborted ? 'timeout' : 'network'
    return { ok: false, errorCode, status: null, latencyMs: elapsed() }
  } finally {
    clearTimeout(timer)
  }
}
