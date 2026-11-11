/** Percentile with linear interpolation (same as Postgres percentile_cont). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (sorted.length - 1) * Math.min(1, Math.max(0, p))
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  const low = sorted[lower] as number
  const high = sorted[upper] as number
  return low + (high - low) * (rank - lower)
}

export interface Distribution {
  n: number
  p50: number | null
  p95: number | null
  max: number | null
  mean: number | null
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { n: 0, p50: null, p95: null, max: null, mean: null }
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
  }
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5)
}
