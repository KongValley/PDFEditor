import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      // 主进程库里 import { app } from 'electron'(recent.ts)/{ BrowserWindow }(print.ts)只在运行时用到,
      // 单测里换成指向临时目录的存根
      electron: resolve(__dirname, 'tests/stubs/electron.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/shared/**/*.ts', 'src/main/lib/**/*.ts', 'src/renderer/src/lib/**/*.ts']
    }
  }
})