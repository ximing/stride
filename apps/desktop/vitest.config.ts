import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'inspect/**/*.test.ts'],
    setupFiles: ['./src/i18n/setup.ts'],
    // Vitest otherwise replaces every .css import, including ?inline, with an empty string.
    css: {
      include: [
        /editor\/chrome\/base\.css/,
        /ui\/tokens\.css/,
        /ui\/primitives\/dialog\.css/,
        /ui\/overlays\/dialog\.css/,
      ],
    },
  },
})
