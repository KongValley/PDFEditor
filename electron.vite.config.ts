import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

// 目标环境:Electron 22(Chromium 108 / Node 16),兼容内网 Win7 32 位机器
export default defineConfig({
  main: {
    build: {
      target: 'node16',
      minify: 'esbuild'
    },
    // 主进程 uncaughtException 用 err.stack 的首帧名定位 fontkit/pdf-lib 异常
    // (src/main/index.ts),压缩不能抹掉函数名
    esbuild: { keepNames: true },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    build: {
      target: 'node16',
      minify: 'esbuild'
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    plugins: [vue()],
    build: {
      target: 'chrome108',
      minify: 'esbuild'
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
})
