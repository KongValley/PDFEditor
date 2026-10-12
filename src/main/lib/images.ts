import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { nativeImage, app } from 'electron'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

/**
 * 「用户确实导入过」的图片路径(规范化后的绝对路径)。
 *
 * 为什么需要:PDF 里的 /PdEditorData 是**不可信输入** —— 他人制作的文件可以塞一条
 * `kind:'image'` 且 `refPath` 指向本机任意绝对路径。若直接照它读盘,打开文档就会把
 * 那个文件读出来回传渲染层,保存时还会嵌进用户导出的 PDF。
 * 因此读盘授权只来自用户自己走 img:choose 导入过的路径,落盘 PDF 里的路径不作数。
 *
 * 授权必须**跨会话持久化**:图片批注的 refPath 会写进 PDF/sidecar,下次打开仍要能显示,
 * 只放内存会让「重开文档 → 图片批注变空白」——那正是引入本检查时最容易造成的功能回归。
 * 落盘形式沿用 recent.json:用户数据目录下的一个 JSON 白名单,只增不删、上限 500 条。
 */
const AUTHORIZED_STORE = 'image-paths.json'
const AUTHORIZED_MAX = 500
let authorizedPaths: Set<string> | null = null

/** 规范化路径用于授权比对(Windows 大小写不敏感;异常时原样返回) */
function normalizeForAuth(p: string): string {
  try {
    return resolve(p).toLowerCase()
  } catch {
    return p
  }
}

function authorizedStorePath(): string {
  return join(app.getPath('userData'), AUTHORIZED_STORE)
}

/** 懒加载授权集合(进程内只读一次) */
function loadAuthorized(): Set<string> {
  if (authorizedPaths) return authorizedPaths
  authorizedPaths = new Set<string>()
  try {
    const raw = readFileSync(authorizedStorePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const p of parsed) if (typeof p === 'string') authorizedPaths.add(p)
    }
  } catch {
    // 首次运行/文件损坏:按空白名单处理(不影响导入,只影响旧批注的图片显示)
  }
  return authorizedPaths
}

/** 登记一条授权并落盘(读-改-写,与 recent 同样的串行化思路) */
function authorizePath(refPath: string): void {
  const set = loadAuthorized()
  const key = normalizeForAuth(refPath)
  if (set.has(key)) return
  set.add(key)
  const kept = [...set].slice(-AUTHORIZED_MAX)
  authorizedPaths = new Set(kept)
  try {
    mkdirSync(dirname(authorizedStorePath()), { recursive: true })
    writeFileSync(authorizedStorePath(), JSON.stringify(kept, null, 2), 'utf8')
  } catch (err) {
    // 授权落盘失败只影响下次启动后的图片恢复,不影响本次会话
    console.warn('[images] 图片路径授权写入失败:', err)
  }
}

/** 是否是用户导入过的图片 */
export function isAuthorizedImagePath(refPath: string): boolean {
  return loadAuthorized().has(normalizeForAuth(refPath))
}

/**
 * 登记"用户刚刚在系统对话框里选中"的路径为可读盘授权。
 * 用户主动选择本身就构成授权凭据(与 PDF 里自带的 refPath 性质完全不同),
 * 所有走原生选择框的入口(单选 img:choose、多选 img:chooseMany)都应调用它。
 */
export function authorizeUserPickedPath(refPath: string): void {
  authorizePath(refPath)
}

/**
 * 读图片信息(调用方已自行确认该路径可信时使用)。
 * 仅供「冒烟脚本按项目内固定路径取图」这类受控场景;外部 PDF 提供的 refPath
 * 一律走 readImageInfo 的授权检查。
 */
export async function readImageInfoAuthorized(refPath: string): Promise<ImageImport> {
  const loaded = await loadImage(refPath)
  return 'error' in loaded ? loaded : loaded.info
}

/** 是否位于应用目录内(冒烟取图的安全边界:只允许读应用自己打包/开发目录里的文件) */
export function isInsideAppPath(refPath: string): boolean {
  try {
    const root = resolve(app.getAppPath()).toLowerCase()
    const target = resolve(refPath).toLowerCase()
    return target.startsWith(root)
  } catch {
    return false
  }
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
  // 该路径可能来自 PDF 里的 /PdEditorData(不可信),未授权则不碰磁盘
  if (!isAuthorizedImagePath(refPath)) return { error: '未授权的图片路径' }
  const loaded = await loadImage(refPath)
  return 'error' in loaded ? loaded : loaded.info
}

/** 读取并登记到内存缓存(用户新插入图片时用:保存阶段按 imgId 取 Buffer) */
export async function importImage(refPath: string): Promise<ImageImport> {
  // 只有走到这里的路径才是"用户主动导入",登记为可读盘授权(并落盘,供下次会话恢复图片批注)
  authorizePath(refPath)
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
  // 保存/导出阶段同样只认用户导入过的路径,否则 PDF 里的路径就能借这里读任意本地文件
  if (!isAuthorizedImagePath(refPath)) return undefined
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
