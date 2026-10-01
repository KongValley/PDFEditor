import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { nativeImage } from 'electron'
import type { ImageInfo } from '@shared/types'

const images = new Map<string, Buffer>()

/** 图片内存缓存上限(未命中时按 refPath 重新读盘) */
const MAX_IMAGES = 20

function evictImages(): void {
  while (images.size > MAX_IMAGES) {
    const oldest = images.keys().next().value
    if (oldest === undefined) break
    images.delete(oldest)
  }
}

export type ImageImport = ImageInfo | { error: string }

function mimeOf(buffer: Buffer): string | null {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) return 'image/png'
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  return null
}

/** 读取图片并登记到内存,返回渲染所需的 dataUrl 与像素尺寸 */
export async function importImage(refPath: string): Promise<ImageImport> {
  let buffer: Buffer
  try {
    buffer = await readFile(refPath)
  } catch (err) {
    return { error: `无法读取图片:${(err as Error).message}` }
  }
  const mime = mimeOf(buffer)
  if (!mime) return { error: '仅支持 PNG/JPEG 格式图片' }
  const size = nativeImage.createFromBuffer(buffer).getSize()
  const imgId = randomUUID()
  images.set(imgId, buffer)
  evictImages()
  return {
    imgId,
    refPath,
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
    width: size.width,
    height: size.height
  }
}

export function getImageBuffer(imgId: string): Buffer | undefined {
  return images.get(imgId)
}

export async function readImageBuffer(refPath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(refPath)
  } catch {
    return undefined
  }
}
