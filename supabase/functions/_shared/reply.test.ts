import { describe, expect, it } from 'vitest'
import type { BotPersona, SnapshotMessage } from './ai-rules.ts'
import {
  DEFAULT_QUESTION,
  buildLlmMessages,
  cleanReply,
  containsBannedWord,
  fallbackMessage,
  pickQuestion,
  welcomeMessage,
  type Question,
} from './reply.ts'

const bot: BotPersona = {
  id: 'b1',
  profileId: 'p-lena',
  displayName: 'Lena',
  role: 'host',
  language: 'en',
  tags: ['pop'],
  activityLevel: 2,
  professionalism: 1,
  bannedWords: ['spoiler'],
  customChatStyle: 'At most one emoji.',
}

const message = (displayName: string, content: string): SnapshotMessage => ({
  id: 1,
  profileId: 'p',
  kind: 'chat',
  content,
  createdAtMs: 0,
  displayName,
  isAi: false,
  mentions: [],
})

describe('buildLlmMessages', () => {
  const room = { name: 'Pop Music Bot', topic: 'Pop music and concerts' }

  it('puts topic, persona and the honesty rule in the system prompt', () => {
    const [system] = buildLlmMessages('silence', room, bot, [], null)
    expect(system?.role).toBe('system')
    expect(system?.content).toContain('Pop music and concerts')
    expect(system?.content).toContain('You are Lena')
    expect(system?.content).toContain('At most 2 short sentences')
    expect(system?.content).toContain('do not lie and do not confirm')
    expect(system?.content).toContain('Never use these words: spoiler')
  })

  it('sends the transcript oldest first and asks to re-spark a silence', () => {
    const [, user] = buildLlmMessages('silence', room, bot, [message('Ana', 'hi'), message('Bo', 'yo')], null)
    expect(user?.content).toMatch(/Ana: hi\nBo: yo/)
    expect(user?.content).toContain('gone quiet')
  })

  it('names the person who mentioned the bot', () => {
    const trigger = message('Ana', '@Lena are you an AI?')
    const [, user] = buildLlmMessages('mention', room, bot, [trigger], trigger)
    expect(user?.content).toContain('Ana just mentioned you')
  })
})

describe('cleanReply', () => {
  const opts = { botName: 'Lena', bannedWords: ['spoiler'] }

  it('keeps at most two sentences', () => {
    expect(cleanReply('One. Two! Three? Four.', opts)).toBe('One. Two!')
  })

  it('removes a "Name:" prefix, quotes, markdown and line breaks', () => {
    expect(cleanReply('**Lena:** "What are you\n*listening* to?"', opts)).toBe('What are you listening to?')
  })

  it('caps the length at 280 characters', () => {
    const long = `${'word '.repeat(100)}end.`
    const cleaned = cleanReply(long, opts)
    expect(cleaned?.length).toBeLessThanOrEqual(280)
    expect(cleaned?.endsWith('…')).toBe(true)
  })

  it('returns null for empty answers or banned words, so the caller falls back', () => {
    expect(cleanReply('   ', opts)).toBeNull()
    expect(cleanReply('No SPOILER please.', opts)).toBeNull()
  })

  it('handles Chinese punctuation', () => {
    expect(cleanReply('你好！最近在听什么？我在听周杰伦。', opts)).toBe('你好！最近在听什么？')
  })
})

describe('containsBannedWord', () => {
  it('matches whole words only', () => {
    expect(containsBannedWord('that is a spoiler!', ['spoiler'])).toBe(true)
    expect(containsBannedWord('spoilers are fine here', ['spoiler'])).toBe(false)
    expect(containsBannedWord('anything', ['', ' '])).toBe(false)
  })
})

describe('pickQuestion', () => {
  const q = (id: number, text: string, tags: string[], language = 'en'): Question => ({ id, text, tags, language })
  const bank = [
    q(1, 'Which song is on repeat?', ['pop']),
    q(2, 'Best concert ever?', ['pop']),
    q(3, 'Plans for the weekend?', []),
    q(4, '最近在听什么？', ['pop'], 'zh'),
  ]
  const first = (): number => 0

  it('prefers topical questions in the bot language', () => {
    expect(pickQuestion(bank, { roomTags: ['pop'], language: 'en', recentTexts: [] }, first)?.id).toBe(1)
    expect(pickQuestion(bank, { roomTags: ['pop'], language: 'zh', recentTexts: [] }, first)?.id).toBe(4)
  })

  it('skips questions asked recently', () => {
    const recent = ['Quick one: Which song is on repeat?']
    expect(pickQuestion(bank, { roomTags: ['pop'], language: 'en', recentTexts: recent }, first)?.id).toBe(2)
  })

  it('falls back to general questions, then to anything', () => {
    const recent = ['Which song is on repeat?', 'Best concert ever?']
    expect(pickQuestion(bank, { roomTags: ['pop'], language: 'en', recentTexts: recent }, first)?.id).toBe(3)
    const all = [...recent, 'Plans for the weekend?']
    expect(pickQuestion(bank, { roomTags: ['pop'], language: 'en', recentTexts: all }, first)).not.toBeNull()
  })

  it('returns null for an empty bank', () => {
    expect(pickQuestion([], { roomTags: [], language: 'en', recentTexts: [] })).toBeNull()
  })
})

describe('templates', () => {
  const question: Question = { id: 1, text: 'Which song is on repeat?', tags: [], language: 'en' }

  it('welcomes by name and asks a question', () => {
    const text = welcomeMessage('Ana', question, () => 0)
    expect(text).toContain('Ana')
    expect(text).toContain('Which song is on repeat?')
  })

  it('never mentions an error in a fallback', () => {
    for (const trigger of ['mention', 'silence'] as const) {
      const text = fallbackMessage(trigger, question, () => 0.99)
      expect(text).toContain('Which song is on repeat?')
      expect(text.toLowerCase()).not.toMatch(/\b(error|sorry|unavailable|ai)\b/)
    }
  })

  it('still says something when the question bank is empty', () => {
    expect(fallbackMessage('silence', null, () => 0)).toContain(DEFAULT_QUESTION)
  })
})
