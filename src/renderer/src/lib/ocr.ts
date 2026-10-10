/**
 * 扫描件整页方向识别(离线):Tesseract 的 OSD 只看文字排布,不认字、也不需要联网。
 *
 * 为什么需要它:墨迹剖面判据在"整页密排"的表格/图页上分不出横竖(行、列两向的墨迹起伏几乎一样),
 * 单页又看不出上下(剖面 180° 前后完全镜像)。OSD 是这类页面上唯一还读得出方向的手段。
 *
 * 资源(worker / wasm 核 / osd 语言数据)由 scripts/sync-ocr-assets.mjs 同步到 renderer public,
 * dev 走 Vite dev server、生产走 app:// —— 与 pdfjs 的 cmaps/standard_fonts 同一套机制。
 */
import { createWorker, type Worker } from 'tesseract.js'
import { docState, getPage } from '../store/document'
import { getPageViewport, pdfjs } from './pdfjs'
import { logEvent } from './log'

/** 渲染给 OSD 的尺寸:实测 1500px 与全尺寸(2481px)结论一致而更快;再小置信度会掉 */
const OCR_LONG_SIDE = 1500
/** 单页识别上限:极慢机器上宁可放弃识别,也不能让"统一方向"卡住 */
const OCR_TIMEOUT_MS = 30000

let workerPromise: Promise<Worker> | null = null

const ocrUrl = (file: string): string => new URL(`./ocr/${file}`, window.location.href).href

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('osd', 0, {
      workerPath: ocrUrl('worker.min.js'),
      corePath: ocrUrl('tesseract-core.wasm.js'),
      // tesseract.js 自己拼 `${langPath}/${lang}.traineddata`;这里给目录,不要尾斜杠
      langPath: ocrUrl('').replace(/\/$/, ''),
      gzip: false
    }).catch((err: unknown) => {
      workerPromise = null // 失败不缓存,下次点击还能重试
      throw err
    })
  }
  return workerPromise
}

/** 释放 worker(它带着几十 MB 的 wasm 堆;分析结束就该还回去,而不是常驻会话) */
export async function releaseOcrWorker(): Promise<void> {
  const pending = workerPromise
  workerPromise = null
  if (!pending) return
  const worker = await pending.catch(() => null)
  await worker?.terminate().catch(() => undefined)
}

export interface OcrOrientation {
  /** 让内容正立所需的旋转(顺时针),与「统一方向」的 delta 同一语义 */
  delta: 0 | 90 | 180 | 270
  /** Tesseract 的方向置信度:各页可比,阈值见 orientation.ts */
  confidence: number
}

function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label}超时(${OCR_TIMEOUT_MS}ms)`)), OCR_TIMEOUT_MS)
    work.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        window.clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

/** 识别一页的整页朝向;失败/超时返回 null(调用方按"没识别出来"处理) */
export async function detectOrientationByOcr(pageNumber: number): Promise<OcrOrientation | null> {
  const page = await getPage(pageNumber)
  const { viewport } = getPageViewport(page, 1, docState.rotationView)
  const scale = Math.min(
    OCR_LONG_SIDE / Math.max(viewport.width, 1),
    OCR_LONG_SIDE / Math.max(viewport.height, 1)
  )
  const target = getPageViewport(page, scale, docState.rotationView).viewport
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(target.width))
  canvas.height = Math.max(1, Math.floor(target.height))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = '#fff' // 透明底会被当成黑底,先铺白
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport: target, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise

  const worker = await withDeadline(getWorker(), '启动 OCR 引擎')
  const { data } = await withDeadline(worker.detect(canvas), `识别第 ${pageNumber} 页方向`)
  const degrees = data.orientation_degrees
  if (degrees !== 0 && degrees !== 90 && degrees !== 180 && degrees !== 270) return null
  const confidence = Number(data.orientation_confidence ?? 0)
  logEvent('debug', 'ocr', '方向识别', { page: pageNumber, delta: degrees, confidence })
  return { delta: degrees, confidence }
}
