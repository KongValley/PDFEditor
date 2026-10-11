/**
 * 图片导出(逐页多图 / 拼接长图)与打印的渲染管线。
 * 从 actions.ts 拆出(它已逼近 1000 行):这里只做「页 → 位图 → 输出」,
 * busy 闸门等入口语义复用 store/ui。
 */
import { pdfjs, getPageViewport } from './pdfjs'
import { paintAnnotations } from './canvasannot'
import { logEvent } from './log'
import { annotState, pageAnnotations } from '../store/annotations'
import { docState, getPage, machineProfile } from '../store/document'
import { commitOpenEditor, runBusy, showToast, type PrintQuality } from '../store/ui'
import type { SaveResult } from '@shared/types'
import { stemOf } from '@shared/paths'

const dirOf = (p: string): string => {
  const index = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return index >= 0 ? p.slice(0, index) : ''
}

const fileStem = (): string => stemOf(docState.filePath ?? '') || 'document'

/** Chrome/Chromium canvas 单边硬限(实测 65535;超出后 getContext('2d') 返回 null) */
const MAX_CANVAS_SIDE = 65535

/** 长图拼接的位图内存上限(字节):省内存机 96MB,其余 256MB */
const longImageByteBudget = (): number => (machineProfile.lowMem ? 96 * 1048576 : 256 * 1048576)

/** 长图能放下的 scale(2 起逐档减半,下限 0.25);0 表示连下限都放不下,应提示缩小范围 */
function fitLongImageScale(pageW: number, pageH: number, count: number, vertical: boolean): number {
  for (let scale = 2; scale >= 0.25; scale /= 2) {
    const span = (vertical ? pageH : pageW) * scale * count
    const other = (vertical ? pageW : pageH) * scale
    if (span <= MAX_CANVAS_SIDE && other <= MAX_CANVAS_SIDE && span * other * 4 <= longImageByteBudget()) {
      return scale
    }
  }
  return 0
}

/** 渲染单页到离屏 canvas(默认 scale=2;批注不画入位图,由调用方按勾选用画笔叠加) */
export async function renderPageToCanvas(
  pageNumber: number,
  includeAnnotations: boolean,
  scale = 2
): Promise<HTMLCanvasElement | null> {
  const page = await getPage(pageNumber)
  const { viewport } = getPageViewport(page, scale, docState.rotationView)
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  await page.render({
    canvasContext: ctx,
    viewport,
    annotationMode: pdfjs.AnnotationMode.DISABLE
  }).promise
  if (includeAnnotations) {
    paintAnnotations(ctx, viewport, pageNumber - 1, pageAnnotations(pageNumber - 1), annotState.imageUrls)
  }
  return canvas
}

/** 导出页面为图片:逐页多图(用户选目录)或拼接长图(单张 PNG) */
export async function exportPagesAsImages(
  pages: number[],
  mode: 'each' | 'long',
  direction?: 'h' | 'v',
  includeAnnotations = true
): Promise<void> {
  if (!docState.pdfDoc || pages.length === 0) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  commitOpenEditor()
  const started = Date.now()
  await runBusy(mode === 'long' ? '正在拼接长图…' : `正在导出 ${pages.length} 张图片…`, async () => {
    try {
      if (mode === 'long') {
        const vertical = direction !== 'h'
        // 先按首页尺寸与页数算出放得下的 scale:超上限时自动降 scale,而不是渲染完再静默失败
        const firstPage = await getPage(pages[0] + 1)
        const baseVp = getPageViewport(firstPage, 1, docState.rotationView).viewport
        const scale = fitLongImageScale(baseVp.width, baseVp.height, pages.length, vertical)
        if (scale === 0) {
          showToast(`长图超出 ${MAX_CANVAS_SIDE} 像素上限,请缩小页码范围`, 'error')
          return
        }
        if (scale < 2) {
          showToast(`页数较多,长图已自动降到 ${Math.round(scale * 100)}% 分辨率以适配内存`)
        }
        const canvases: HTMLCanvasElement[] = []
        for (const index of pages) {
          const canvas = await renderPageToCanvas(index + 1, includeAnnotations, scale)
          if (canvas) canvases.push(canvas)
        }
        if (canvases.length === 0) return
        const width = vertical ? Math.max(...canvases.map((c) => c.width)) : canvases.reduce((sum, c) => sum + c.width, 0)
        const height = vertical ? canvases.reduce((sum, c) => sum + c.height, 0) : Math.max(...canvases.map((c) => c.height))
        const out = document.createElement('canvas')
        out.width = width
        out.height = height
        const ctx = out.getContext('2d')
        if (!ctx) {
          showToast('画布分配失败,请缩小页码范围', 'error')
          return
        }
        let offset = 0
        for (const c of canvases) {
          ctx.drawImage(c, vertical ? (width - c.width) / 2 : offset, vertical ? offset : (height - c.height) / 2)
          offset += vertical ? c.height : c.width
        }
        const result = (await window.pdfAPI.invoke('app:saveImage', {
          defaultName: `${fileStem()}-长图.png`,
          dir: docState.filePath ? dirOf(docState.filePath) : undefined,
          dataUrl: out.toDataURL('image/png')
        })) as SaveResult
        if (result.ok) showToast(`已导出长图:${result.savedPath ?? ''}`)
        else if (!result.canceled) showToast(result.error ?? '导出长图失败', 'error')
        return
      }
      // 逐页多图:每页 base64 约为位图的 1.33 倍,且全部累积在 dataUrls[] 里再过 IPC
      const probePage = await getPage(pages[0] + 1)
      const probeVp = getPageViewport(probePage, 2, docState.rotationView).viewport
      const perPageBytes = Math.floor(probeVp.width * probeVp.height * 4 * 1.33)
      if (pages.length * perPageBytes > longImageByteBudget() * 2) {
        showToast('页数较多,批量导出可能耗尽内存,请分批导出', 'error')
        return
      }
      const dataUrls: string[] = []
      const names: string[] = []
      for (const index of pages) {
        const canvas = await renderPageToCanvas(index + 1, includeAnnotations)
        if (!canvas) continue
        dataUrls.push(canvas.toDataURL('image/png'))
        names.push(`${fileStem()}-第${index + 1}页.png`)
      }
      if (dataUrls.length === 0) return
      const result = (await window.pdfAPI.invoke('app:saveImages', { names, dataUrls })) as SaveResult
      if (result.ok) showToast(`已导出 ${dataUrls.length} 张图片:${result.savedPath ?? ''}`)
      else if (!result.canceled) showToast(result.error ?? '导出图片失败', 'error')
    } catch (err) {
      showToast(`导出图片失败:${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  })
  // 导出图片的渲染与 base64 全在渲染层,主进程只收到结果:这里记入口耗时(排障唯一来源)
  logEvent('info', 'export', '导出图片', { mode, count: pages.length, ms: Date.now() - started })
}

/** 打印 scale:高清 ≈300dpi 单页位图 33MB,叠加 print.ts 隐藏窗口的解码峰值;
 *  省内存机自动降回标准档。纯函数便于冒烟直接断言,不必触发系统打印对话框。 */
export function resolvePrintScale(quality: PrintQuality): number {
  return quality === 'high' && !machineProfile.lowMem ? 300 / 72 : 2
}

/** 打印单页 PNG 字节:标准 2×(≈144dpi)、高清 300dpi(Uint8Array 走结构化克隆,免 base64×1.33) */
export async function renderPrintPageDataUrl(
  pageNumber: number,
  includeAnnotations: boolean,
  quality: PrintQuality
): Promise<Uint8Array | null> {
  const scale = resolvePrintScale(quality)
  const canvas = await renderPageToCanvas(pageNumber, includeAnnotations, scale)
  if (!canvas) return null
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

/** 打印:逐页渲染并即传主进程(峰值只占一页),最后提交给系统打印对话框 */
export async function printPages(
  pages: number[],
  includeAnnotations = true,
  quality: PrintQuality = 'standard'
): Promise<void> {
  if (!docState.pdfDoc || pages.length === 0) return
  commitOpenEditor()
  if (quality === 'high' && machineProfile.lowMem) {
    showToast('本机内存较小,高清打印已自动改为标准清晰度')
  }
  await runBusy('正在准备打印…', () => printPagesInner(pages, includeAnnotations, quality))
}

/** 打印本体(由 printPages 经 busy 闸门调用) */
async function printPagesInner(
  pages: number[],
  includeAnnotations: boolean,
  quality: PrintQuality
): Promise<void> {
  let jobId: string | null = null
  try {
    const sizesMm = pages.map((index) => {
      const box = docState.pageBoxes[index]
      if (!box) return { w: 210, h: 297 } // 缺页尺寸信息时按 A4 输出,不中断打印
      const rotated = docState.rotationView % 180 !== 0
      const w = rotated ? box.h : box.w
      const h = rotated ? box.w : box.h
      return { w: (w * 25.4) / 72, h: (h * 25.4) / 72 }
    })
    const prepared = (await window.pdfAPI.invoke('app:printPrepare', {
      jobName: `${fileStem()}-打印`,
      pageCount: pages.length,
      sizesMm
    })) as { ok: boolean; jobId?: string; error?: string }
    if (!prepared.ok || !prepared.jobId) {
      showToast(prepared.error ?? '打印失败', 'error')
      return
    }
    jobId = prepared.jobId
    for (const [i, index] of pages.entries()) {
      showToast(`正在渲染打印页面 ${i + 1} / ${pages.length}…`)
      const bytes = await renderPrintPageDataUrl(index + 1, includeAnnotations, quality)
      if (!bytes) throw new Error(`第 ${index + 1} 页渲染失败`)
      const added = (await window.pdfAPI.invoke('app:printAddPage', {
        jobId,
        index: i,
        bytes
      })) as { ok: boolean; error?: string }
      if (!added.ok) throw new Error(added.error ?? '打印页面写入失败')
    }
    const result = (await window.pdfAPI.invoke('app:printCommit', { jobId })) as {
      ok: boolean
      canceled?: boolean
      error?: string
    }
    jobId = null
    if (result.ok) showToast('已提交打印')
    else if (!result.canceled) showToast(result.error ?? '打印失败', 'error')
  } catch (err) {
    showToast(`打印失败:${err instanceof Error ? err.message : String(err)}`, 'error')
  } finally {
    if (jobId) void window.pdfAPI.invoke('app:printAbort', { jobId })
  }
}
