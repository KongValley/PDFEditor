/**
 * 图片转 PDF:多张 PNG/JPEG 合成一份文档,每张图一页。
 * 只做"图 → 页"的排布,不碰注释与表单(输出的是纯页面文档,之后可再编辑)。
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { nativeImage } from 'electron'
import { PDFDocument } from 'pdf-lib'
import { mimeOf } from './images'

/** 页面尺寸模式:'image' = 按图像像素 96 DPI 换算;'a4' = A4(方向随图像长宽) */
export type ImagePageMode = 'image' | 'a4'

/** A4 短边/长边(pt),与插入空白页使用的纸张一致(docops.ts:49) */
const A4_SHORT = 595.28
const A4_LONG = 841.89
/** A4 模式下图像四周留白(pt) */
const A4_MARGIN = 24
/** 「按图像尺寸」时把像素换算成点用的 DPI */
const IMAGE_DPI = 96

/** 单次最多转换的图片数:embed 后全部驻留内存,过多会撑爆内存 */
export const MAX_IMAGES = 200

export interface ConvertProgress {
  done: number
  total: number
  name: string
}

export interface ImageToPdfResult {
  /** 实际写出的页数(成功嵌入的图片数) */
  pages: number
  /** 逐张失败的原因(不中断其余图片) */
  errors: Array<{ path: string; error: string }>
  /** PDF 字节;页数为 0 时为 null(全部失败) */
  bytes: Uint8Array | null
}

/** 逐张嵌入为页;每张完成后回调进度。返回页数与失败明细 */
export async function imagesToPdf(
  paths: string[],
  pageMode: ImagePageMode,
  hooks: { onProgress?: (p: ConvertProgress) => void } = {}
): Promise<ImageToPdfResult> {
  if (paths.length === 0) throw new Error('未选择图片')
  if (paths.length > MAX_IMAGES) throw new Error(`一次最多转换 ${MAX_IMAGES} 张图片,请分批处理`)
  const doc = await PDFDocument.create()
  const errors: Array<{ path: string; error: string }> = []
  let done = 0
  for (const path of paths) {
    done++
    let buffer: Buffer
    try {
      buffer = await readFile(path)
    } catch (err) {
      errors.push({ path, error: `无法读取:${(err as Error).message}` })
      hooks.onProgress?.({ done, total: paths.length, name: basename(path) })
      continue
    }
    const mime = mimeOf(buffer)
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      errors.push({ path, error: '仅支持 PNG / JPEG 图片' })
      hooks.onProgress?.({ done, total: paths.length, name: basename(path) })
      continue
    }
    const { width, height } = nativeImage.createFromBuffer(buffer).getSize()
    let image
    try {
      image = mime === 'image/png' ? await doc.embedPng(buffer) : await doc.embedJpg(buffer)
    } catch (err) {
      errors.push({ path, error: `无法解码图片:${(err as Error).message}` })
      hooks.onProgress?.({ done, total: paths.length, name: basename(path) })
      continue
    }
    if (pageMode === 'a4') {
      // 方向随图像:仅真正的横向图用横向 A4(方形按纵向处理)
      const landscape = width > height
      const pageW = landscape ? A4_LONG : A4_SHORT
      const pageH = landscape ? A4_SHORT : A4_LONG
      const scale = Math.min(
        (pageW - 2 * A4_MARGIN) / width,
        (pageH - 2 * A4_MARGIN) / height
      )
      const drawW = width * scale
      const drawH = height * scale
      const page = doc.addPage([pageW, pageH])
      page.drawImage(image, { x: (pageW - drawW) / 2, y: (pageH - drawH) / 2, width: drawW, height: drawH })
    } else {
      // 按图像尺寸:像素按 96 DPI 换算成点,铺满整页无白边
      const page = doc.addPage([(width * 72) / IMAGE_DPI, (height * 72) / IMAGE_DPI])
      page.drawImage(image, { x: 0, y: 0, width: (width * 72) / IMAGE_DPI, height: (height * 72) / IMAGE_DPI })
    }
    hooks.onProgress?.({ done, total: paths.length, name: basename(path) })
  }
  const pages = doc.getPageCount()
  if (pages === 0) return { pages, errors, bytes: null }
  const bytes = await doc.save({ useObjectStreams: false })
  return { pages, errors, bytes }
}