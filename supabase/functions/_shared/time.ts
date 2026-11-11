/**
 * Postgres sends times like "2026-11-10 15:03:12.123456+00". Some browsers
 * (older Safari) reject that shape, so normalise it before Date.parse:
 * "T" separator, milliseconds only, and a "+00:00" style offset.
 */
export function parseTimestampMs(value: string): number {
  const normalised = value
    .trim()
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00')
  const ms = Date.parse(normalised)
  if (Number.isNaN(ms)) throw new Error(`Unreadable timestamp: ${value}`)
  return ms
}
