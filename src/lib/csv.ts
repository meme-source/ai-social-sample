/**
 * Rows → CSV text (RFC 4180). Cells that a spreadsheet would run as a formula
 * (starting with = + - @) get a leading apostrophe: feedback text comes from
 * testers, and opening it in Excel must not execute anything.
 */
export function toCsv(rows: readonly Record<string, unknown>[], columns?: readonly string[]): string {
  const header = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const lines = [header.map(cell).join(','), ...rows.map((row) => header.map((key) => cell(row[key])).join(','))]
  return `${lines.join('\r\n')}\r\n`
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Start a download of `csv` in the browser. */
export function downloadCsv(filename: string, csv: string): void {
  // The BOM makes Excel read UTF-8 (Chinese text, emoji) correctly.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
