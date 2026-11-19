/**
 * 系统字体列表(渲染层):首次需要时经 IPC 读取,之后常驻。
 * 列表只含字族名/本地化名;实际字体文件与嵌入由主进程处理。
 */
import { reactive } from 'vue'
import type { SystemFontInfo } from '@shared/types'

/** 与旧版画布/导出保持一致的默认字体栈(未指定字体时使用) */
export const DEFAULT_FONT_STACK = 'SimHei, "Microsoft YaHei", sans-serif'

interface FontState {
  loaded: boolean
  loading: boolean
  error: string
  fonts: SystemFontInfo[]
}

export const fontState = reactive<FontState>({
  loaded: false,
  loading: false,
  error: '',
  fonts: []
})

let pending: Promise<void> | null = null

/** 拉取系统字体列表(并发调用共享同一次请求;失败后允许重试) */
export function ensureFontsLoaded(): void {
  if (fontState.loaded || pending) return
  pending = (async () => {
    fontState.loading = true
    try {
      const result = (await window.pdfAPI.invoke('fonts:list')) as {
        ok: boolean
        fonts?: SystemFontInfo[]
        error?: string
      }
      if (result.ok && result.fonts) {
        fontState.fonts = result.fonts
        fontState.loaded = true
        fontState.error = ''
      } else {
        fontState.error = result.error ?? '读取系统字体失败'
      }
    } catch (err) {
      fontState.error = err instanceof Error ? err.message : String(err)
    } finally {
      fontState.loading = false
      pending = null
    }
  })()
}

/**
 * 注释字体 → CSS font-family。
 * 字体名来自注释数据(可能来自不可信 PDF),这里剥掉引号/分号/花括号等可破坏
 * 声明结构的字符;真正的查找与嵌入由主进程按「已安装字族名」精确匹配。
 */
export function fontCss(family?: string): string {
  const safe = (family ?? '')
    .replace(/["'\\;{}\r\n\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 120)
  return safe === '' ? DEFAULT_FONT_STACK : `"${safe}", ${DEFAULT_FONT_STACK}`
}
