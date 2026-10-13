import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts', 'inspect/**/*.test.ts'],
  },
})
