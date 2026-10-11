import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { nativeImage } from 'electron'
import { statSync } from 'node:fs'
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

/** refPath 磁盘读取的小缓存(拆分多块/连续保存时同一张图不再反复读盘);
 * 键含 mtime+size,文件被替换后自然失效 */
const DISK_CACHE_MAX = 8
const diskCache = new Map<string, Buffer>()

function evictDiskCache(): void {
  while (diskCache.size > DISK_CACHE_MAX) {
    const oldest = diskCache.keys().next().value
    if (oldest === undefined) break
    diskCache.delete(oldest)
  }
}

export type ImageImport = ImageInfo | { error: string }

/** 按文件头判断 PNG / JPEG(图片转 PDF 复用;不信任扩展名) */
export function mimeOf(buffer: Buffer): string | null {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) return 'image/png'
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  return null
}

/** 读盘 + 解码 + 编码(两条导出共用) */
async function loadImage(
  refPath: string
): Promise<{ info: ImageInfo; buffer: Buffer } | { error: string }> {
  let buffer: Buffer
  try {
    buffer = await readFile(refPath)
  } catch (err) {
    return { error: `无法读取图片:${(err as Error).message}` }
  }
  const mime = mimeOf(buffer)
  if (!mime) return { error: '仅支持 PNG/JPEG 格式图片' }
  const decoded = nativeImage.createFromBuffer(buffer)
  const size = decoded.getSize()
  // 屏显 dataUrl 按最长边降采样:一张 12MP 照片的 base64 约 27MB 字符串 + 解码位图约 48MB,
  // 全分辨率只会撑爆内存;PDF 嵌入仍用下面的原始 buffer,输出质量不受影响
  const MAX_DISPLAY_EDGE = 2400
  let dataUrlBuffer = buffer
  if (Math.max(size.width, size.height) > MAX_DISPLAY_EDGE) {
    const ratio = MAX_DISPLAY_EDGE / Math.max(size.width, size.height)
    const resized = decoded.resize({
      width: Math.max(1, Math.round(size.width * ratio)),
      height: Math.max(1, Math.round(size.height * ratio))
    })
    dataUrlBuffer = mime === 'image/png' ? Buffer.from(resized.toPNG()) : Buffer.from(resized.toJPEG(82))
  }
  return {
    buffer,
    info: {
      imgId: '',
      refPath,
      dataUrl: `data:${mime};base64,${dataUrlBuffer.toString('base64')}`,
      width: size.width,
      height: size.height
    }
  }
}

/**
 * 只取图片信息,不占用内存缓存(imgId 固定为空串)。
 * `img:getByPath` 走这条:渲染层用批注自己的 imgId 作键,这里生成的 UUID 会被丢弃,
 * 写进缓存只会留下一份没人引用的重复 Buffer。
 */
export async function readImageInfo(refPath: string): Promise<ImageImport> {
  const loaded = await loadImage(refPath)
  return 'error' in loaded ? loaded : loaded.info
}

/** 读取并登记到内存缓存(用户新插入图片时用:保存阶段按 imgId 取 Buffer) */
export async function importImage(refPath: string): Promise<ImageImport> {
  const loaded = await loadImage(refPath)
  if ('error' in loaded) return loaded
  const imgId = randomUUID()
  images.set(imgId, loaded.buffer)
  evictImages()
  return { ...loaded.info, imgId }
}

export function getImageBuffer(imgId: string): Buffer | undefined {
  return images.get(imgId)
}

export async function readImageBuffer(refPath: string): Promise<Buffer | undefined> {
  let key: string
  try {
    const st = statSync(refPath)
    key = `${refPath}|${st.mtimeMs}|${st.size}`
  } catch {
    return undefined
  }
  const cached = diskCache.get(key)
  if (cached) return cached
  try {
    const buffer = await readFile(refPath)
    diskCache.delete(key)
    diskCache.set(key, buffer)
    evictDiskCache()
    return buffer
  } catch {
    return undefined
  }
}
