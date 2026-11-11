import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'supabase/functions/_shared/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
})
