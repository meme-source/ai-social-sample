import { describe, expect, it } from 'vitest'
import { callChatCompletion, classifyStatus, resolveLlmConfig, type LlmConfig } from './llm.ts'

const env = (values: Record<string, string>) => (name: string): string | undefined => values[name]

describe('resolveLlmConfig', () => {
  it('defaults to DeepSeek deepseek-flash in non-thinking mode', () => {
    const config = resolveLlmConfig(env({ LLM_API_KEY: 'k' }))
    expect(config).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      provider: 'api.deepseek.com',
      timeoutMs: 8_000,
      maxTokens: 120,
      extraBody: { thinking: { type: 'disabled' } },
    })
  })

  it('switches provider with secrets only (no DeepSeek-only fields sent elsewhere)', () => {
    const config = resolveLlmConfig(
      env({ LLM_BASE_URL: 'https://api.openai.com/v1/', LLM_MODEL: 'gpt-mini', LLM_API_KEY: 'k' }),
    )
    expect(config).toMatchObject({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-mini', extraBody: {} })
  })

  it('accepts LLM_EXTRA_BODY and warns about invalid JSON', () => {
    expect(resolveLlmConfig(env({ LLM_EXTRA_BODY: '{"enable_thinking":false}' })).extraBody).toEqual({
      enable_thinking: false,
    })
    const bad = resolveLlmConfig(env({ LLM_EXTRA_BODY: '[1,2]' }))
    expect(bad.warning).toMatch(/not a JSON object/)
  })

  it('keeps the timeout below the 15 s room lock', () => {
    expect(resolveLlmConfig(env({ LLM_TIMEOUT_MS: '60000' })).timeoutMs).toBe(12_000)
    expect(resolveLlmConfig(env({ LLM_TIMEOUT_MS: 'soon' })).timeoutMs).toBe(8_000)
  })
})

describe('classifyStatus', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [402, 'no_balance'],
    [429, 'rate_limited'],
    [400, 'bad_request'],
    [404, 'not_found'],
    [503, 'server_error'],
    [418, 'bad_response'],
  ])('%i → %s', (status, code) => {
    expect(classifyStatus(status)).toBe(code)
  })
})

describe('callChatCompletion', () => {
  const config: LlmConfig = { ...resolveLlmConfig(env({ LLM_API_KEY: 'test-key' })), timeoutMs: 50 }
  const messages = [{ role: 'user' as const, content: 'hi' }]

  it('posts an OpenAI-style request and reads text + token usage', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
      seen = { url, init }
      return Response.json({
        choices: [{ message: { content: 'Hello there!' } }],
        usage: { prompt_tokens: 50, completion_tokens: 4 },
      })
    }
    const result = await callChatCompletion(config, messages, fakeFetch)
    expect(result).toMatchObject({ ok: true, text: 'Hello there!', promptTokens: 50, completionTokens: 4 })
    expect(seen!.url).toBe('https://api.deepseek.com/chat/completions')
    const body = JSON.parse(String(seen!.init.body))
    expect(body).toMatchObject({ model: 'deepseek-flash', max_tokens: 120, stream: false, thinking: { type: 'disabled' } })
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
  })

  it('maps HTTP errors to codes (wrong key → auth, no credit → no_balance)', async () => {
    const status = (code: number) => async (): Promise<Response> => new Response('nope', { status: code })
    expect(await callChatCompletion(config, messages, status(401))).toMatchObject({ ok: false, errorCode: 'auth' })
    expect(await callChatCompletion(config, messages, status(402))).toMatchObject({ ok: false, errorCode: 'no_balance' })
  })

  it('times out', async () => {
    const hang = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    expect(await callChatCompletion(config, messages, hang)).toMatchObject({ ok: false, errorCode: 'timeout' })
  })

  it('reports network failures, empty replies and junk bodies', async () => {
    const boom = async (): Promise<Response> => {
      throw new TypeError('fetch failed')
    }
    expect(await callChatCompletion(config, messages, boom)).toMatchObject({ errorCode: 'network' })
    const empty = async (): Promise<Response> => Response.json({ choices: [{ message: { content: '  ' } }] })
    expect(await callChatCompletion(config, messages, empty)).toMatchObject({ errorCode: 'empty_reply' })
    const junk = async (): Promise<Response> => new Response('<html>', { status: 200 })
    expect(await callChatCompletion(config, messages, junk)).toMatchObject({ errorCode: 'bad_response' })
  })

  it('does not call anything without an API key', async () => {
    const noKey = { ...config, apiKey: '' }
    const neverCalled = async (): Promise<Response> => {
      throw new Error('should not be called')
    }
    expect(await callChatCompletion(noKey, messages, neverCalled)).toMatchObject({ errorCode: 'not_configured' })
  })
})
