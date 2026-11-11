/**
 * Draws the app icons as PNG files with no image library (plain Node + zlib).
 *   npx tsx scripts/make-icons.ts
 * Output: public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

type Rgba = [number, number, number, number]

const TOP_LEFT: Rgba = [167, 123, 255, 255] // #a77bff
const BOTTOM_RIGHT: Rgba = [91, 43, 214, 255] // #5b2bd6
const WHITE: Rgba = [255, 255, 255, 255]
const DOT: Rgba = [91, 43, 214, 255]

interface IconSpec {
  file: string
  size: number
  roundCorners: boolean // transparent rounded corners ("any" icons)
  contentScale: number // < 1 keeps the drawing inside the maskable safe zone
}

const ICONS: IconSpec[] = [
  { file: 'icon-192.png', size: 192, roundCorners: true, contentScale: 1 },
  { file: 'icon-512.png', size: 512, roundCorners: true, contentScale: 1 },
  { file: 'icon-maskable-512.png', size: 512, roundCorners: false, contentScale: 0.78 },
  // iOS rounds the corners itself and shows transparency as black, so: full square.
  { file: 'apple-touch-icon.png', size: 180, roundCorners: false, contentScale: 1 },
]

const inRoundedRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

const inTriangle = (px: number, py: number, a: number[], b: number[], c: number[]): boolean => {
  const sign = (p1: number[], p2: number[], p3: number[]): number =>
    (p1[0]! - p3[0]!) * (p2[1]! - p3[1]!) - (p2[0]! - p3[0]!) * (p1[1]! - p3[1]!)
  const p = [px, py]
  const d1 = sign(p, a, b)
  const d2 = sign(p, b, c)
  const d3 = sign(p, c, a)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/** Colour at a point in unit space (0..1), or null for transparent. */
function shade(u: number, v: number, spec: IconSpec): Rgba | null {
  if (spec.roundCorners && !inRoundedRect(u, v, 0, 0, 1, 1, 0.22)) return null
  // Map into the content box (centred, scaled for the maskable safe zone).
  const s = spec.contentScale
  const x = (u - 0.5) / s + 0.5
  const y = (v - 0.5) / s + 0.5
  const inBubble =
    inRoundedRect(x, y, 0.22, 0.24, 0.78, 0.64, 0.1) || inTriangle(x, y, [0.34, 0.6], [0.47, 0.6], [0.32, 0.76])
  if (inBubble) {
    for (const dx of [0.37, 0.5, 0.63]) if ((x - dx) ** 2 + (y - 0.44) ** 2 <= 0.045 ** 2) return DOT
    return WHITE
  }
  const t = (u + v) / 2
  return TOP_LEFT.map((c, i) => Math.round(c + (BOTTOM_RIGHT[i]! - c) * t)) as Rgba
}

function render(spec: IconSpec): Buffer {
  const { size } = spec
  const samples = 4 // 4×4 supersampling for smooth edges
  const rows: Buffer[] = []
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4) // first byte = PNG filter type 0
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0]
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const color = shade((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size, spec)
          if (!color) continue
          acc[0]! += color[0] * color[3]
          acc[1]! += color[1] * color[3]
          acc[2]! += color[2] * color[3]
          acc[3]! += color[3]
        }
      }
      const alpha = acc[3]! / (samples * samples)
      const o = 1 + px * 4
      if (acc[3]! > 0) {
        row[o] = Math.round(acc[0]! / acc[3]!)
        row[o + 1] = Math.round(acc[1]! / acc[3]!)
        row[o + 2] = Math.round(acc[2]! / acc[3]!)
      }
      row[o + 3] = Math.round(alpha)
    }
    rows.push(row)
  }
  return encodePng(size, size, Buffer.concat(rows))
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(width: number, height: number, filteredRows: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filteredRows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const outDir = new URL('../public/icons/', import.meta.url)
mkdirSync(outDir, { recursive: true })
for (const spec of ICONS) {
  writeFileSync(new URL(spec.file, outDir), render(spec))
  process.stdout.write(`wrote public/icons/${spec.file}\n`)
}
