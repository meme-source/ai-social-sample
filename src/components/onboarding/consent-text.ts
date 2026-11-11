/**
 * The consent screen's words. DATA.md explains each point in more detail.
 * Change CONSENT_VERSION whenever the text changes: everyone is asked again.
 */
export const CONSENT_VERSION = '2026-11-10'

export const CONSENT_POINTS: { title: string; body: string }[] = [
  {
    title: 'This is a prototype test',
    body: 'You are helping test a chat app for a design project. Things may break — that is useful to know.',
  },
  {
    title: 'Some members are AI',
    body: 'Rooms mix real people and AI members, and we don’t say who is who: that is part of the test. AI members won’t claim to be human, but they won’t confirm it either.',
  },
  {
    title: 'What we record',
    body: 'Your nickname, avatar, messages and feedback, plus automatic app logs: errors, connection quality and how fast messages arrive. The logs never contain what you wrote. Recent messages are sent to an AI provider (DeepSeek) so AI members can reply.',
  },
  {
    title: 'Keep it anonymous',
    body: 'Use a nickname. Please don’t share your real name, phone number, address or anything private in the chat.',
  },
  {
    title: 'Your choice',
    body: 'You can stop at any time. To have your data deleted, show the organiser the ID on the “My ID” page. Data is used only to improve this prototype and is kept until the project ends.',
  },
]
