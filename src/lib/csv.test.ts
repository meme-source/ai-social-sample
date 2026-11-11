import { describe, expect, it } from 'vitest'
import { toCsv } from './csv.ts'

describe('toCsv', () => {
  it('writes a header and one line per row', () => {
    expect(toCsv([{ id: 1, name: 'Ana' }, { id: 2, name: 'Bo' }])).toBe('id,name\r\n1,Ana\r\n2,Bo\r\n')
  })

  it('quotes commas, quotes and line breaks', () => {
    expect(toCsv([{ note: 'a, "b"\nc' }])).toBe('note\r\n"a, ""b""\nc"\r\n')
  })

  it('writes objects as JSON and empty values as blanks', () => {
    expect(toCsv([{ data: { n: 1 }, gone: null, missing: undefined }])).toBe('data,gone,missing\r\n"{""n"":1}",,\r\n')
  })

  it('defuses spreadsheet formulas but keeps negative numbers', () => {
    expect(toCsv([{ a: '=HYPERLINK("x")', b: '@SUM(1)', c: -5, d: '-3.5' }])).toBe(
      'a,b,c,d\r\n"\'=HYPERLINK(""x"")",\'@SUM(1),-5,-3.5\r\n',
    )
  })

  it('uses the given column order and fills gaps', () => {
    expect(toCsv([{ b: 2 }, { a: 1 }], ['a', 'b'])).toBe('a,b\r\n,2\r\n1,\r\n')
  })
})
