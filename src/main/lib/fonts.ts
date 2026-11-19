/**
 * 系统字体枚举与读取(供批注字体选择 / 保存时嵌入)。
 *
 * 只做「足够选字体、足够嵌入」的两件事:
 *  - 枚举:C:\Windows\Fonts、当前用户字体目录(%LOCALAPPDATA%\Microsoft\Windows\Fonts),
 *    非 Windows 下扫常见字体目录。逐个字体只读 **表目录 + name 表**(几 KB),不读整份
 *    字体文件 —— 本机 373 个字体文件共 1.3GB,整读会让打开字体下拉框卡住数秒。
 *  - 读取:选中字体保存时才读整份文件;TTC/OTC(ttcf)需要把选中的那一面抽成独立
 *    sfnt,pdf-lib 只能嵌入单面字体文件。
 */
import type { Dirent } from 'node:fs'
import { readdir, open, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import type { SystemFontInfo } from '@shared/types'

/** pdf-lib(fontkit)可直接嵌入的字体文件类型;.fon/.pfm/.pfb 是位图/Type1,不支持 */
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc'])

/** 字体文件上限:病态超大文件直接跳过,避免一次读取把 32 位进程地址空间吃穿 */
const MAX_FONT_FILE_BYTES = 128 * 1024 * 1024

/** 读取字体字节的缓存上限(多份文档批量拆分/导出时避免反复读 10–20MB) */
const FONT_BYTES_CACHE_LIMIT = 64 * 1024 * 1024

const TTC_TAG = 0x74746366 // 'ttcf'
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565, 0x74797031]) // 1.0 / OTTO / true / typ1

/** 内部字体面(带别名与磁盘路径;渲染层只拿 SystemFontInfo) */
export interface SystemFontFace {
  family: string
  label: string
  style: string
  postscriptName: string
  file: string
  index: number
  /** 用于匹配 PDF 里保存的字体名(英文名、本地化名、排版族名) */
  aliases: string[]
}

interface NameRecord {
  platformID: number
  encodingID: number
  languageID: number
  nameID: number
  text: string
}

interface TableRecord {
  tag: string
  offset: number
  length: number
}

const ENGLISH_LANG = 0x0409
/** 中文(简/繁)语言 ID:name 表里常有「黑体/微软雅黑」这类本地化名 */
const CHINESE_LANGS = [0x0804, 0x0404, 0x0c04, 0x1004]

let fontListPromise: Promise<SystemFontFace[]> | null = null
let aliasMap = new Map<string, SystemFontFace>()

/** 字体字节 LRU(按加入顺序淘汰;同一字体文件可能被多份结果复用) */
const fontBytesCache = new Map<string, Buffer>()
let fontBytesCached = 0

function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

function decodeUtf16Be(buffer: Buffer): string {
  return Buffer.from(buffer.subarray(0, buffer.length & ~1))
    .swap16()
    .toString('utf16le')
}

/** 解析 name 表(格式 0/1;格式 1 的语言标签记录对取值无影响) */
export function parseNameTable(buffer: Buffer): NameRecord[] {
  if (buffer.length < 6) return []
  const count = buffer.readUInt16BE(2)
  const stringOffset = buffer.readUInt16BE(4)
  const records: NameRecord[] = []
  for (let i = 0; i < count; i++) {
    const recordAt = 6 + i * 12
    if (recordAt + 12 > buffer.length) break
    const platformID = buffer.readUInt16BE(recordAt)
    const encodingID = buffer.readUInt16BE(recordAt + 2)
    const languageID = buffer.readUInt16BE(recordAt + 4)
    const nameID = buffer.readUInt16BE(recordAt + 6)
    const length = buffer.readUInt16BE(recordAt + 8)
    const offset = buffer.readUInt16BE(recordAt + 10)
    const start = stringOffset + offset
    if (start + length > buffer.length) continue
    let text = ''
    if (platformID === 0 || platformID === 3) {
      // Unicode / Windows:UTF-16BE
      if (length % 2 === 0) text = decodeUtf16Be(buffer.subarray(start, start + length))
    } else if (platformID === 1) {
      // Macintosh Roman:家族名基本是 ASCII;非 ASCII 本地化名由 platform 3 覆盖
      text = buffer.subarray(start, start + length).toString('latin1')
    }
    text = sanitizeText(text)
    if (text) records.push({ platformID, encodingID, languageID, nameID, text })
  }
  return records
}

function pickName(records: NameRecord[], nameIds: number[], languages: number[]): string | undefined {
  for (const nameId of nameIds) {
    for (const language of languages) {
      // Windows(platform 3)的 Unicode 记录;其它平台的同名字段由 anyName 兜底
      const hit = records.find(
        (record) => record.nameID === nameId && record.platformID === 3 && record.languageID === language
      )
      if (hit) return hit.text
    }
  }
  return undefined
}

function anyName(records: NameRecord[], nameIds: number[]): string | undefined {
  for (const nameId of nameIds) {
    // Windows Unicode 优先,其次 Unicode 平台,最后 Mac
    const hit =
      records.find((record) => record.nameID === nameId && record.platformID === 3) ??
      records.find((record) => record.nameID === nameId && record.platformID === 0) ??
      records.find((record) => record.nameID === nameId)
    if (hit) return hit.text
  }
  return undefined
}

function namesToFaces(records: NameRecord[], file: string, index: number): SystemFontFace | null {
  const familyEn =
    pickName(records, [1], [ENGLISH_LANG]) ??
    pickName(records, [16], [ENGLISH_LANG]) ??
    anyName(records, [1, 16])
  if (!familyEn) return null

  const familyZh = pickName(records, [1, 16], CHINESE_LANGS)
  const label = familyZh && familyZh !== familyEn ? familyZh : familyEn
  const style =
    pickName(records, [2], [ENGLISH_LANG]) ?? pickName(records, [17], [ENGLISH_LANG]) ?? anyName(records, [2, 17]) ?? 'Regular'
  const postscriptName = anyName(records, [6]) ?? ''

  const aliases = new Set<string>([familyEn, label, postscriptName])
  for (const record of records) {
    if (record.nameID === 1 || record.nameID === 16) aliases.add(record.text)
  }

  return {
    family: sanitizeText(familyEn),
    label: sanitizeText(label),
    style: sanitizeText(style),
    postscriptName: sanitizeText(postscriptName),
    file,
    index,
    aliases: [...aliases].map(sanitizeText).filter((value) => value !== '')
  }
}

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, offset + read)
    if (bytesRead <= 0) break
    read += bytesRead
  }
  return buffer.subarray(0, read)
}

/** 读取单个字体文件的所有面(TTC 多面)的名字信息 */
export async function parseFontFile(file: string): Promise<SystemFontFace[]> {
  let handle: FileHandle | null = null
  try {
    handle = await open(file, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_FONT_FILE_BYTES) return []

    const head = await readAt(handle, 0, Math.min(stat.size, 64 * 1024))
    if (head.length < 12) return []

    let offsets: number[] = []
    if (head.readUInt32BE(0) === TTC_TAG) {
      const count = head.readUInt32BE(8)
      if (count === 0 || count > 256 || head.length < 12 + count * 4) return []
      for (let i = 0; i < count; i++) offsets.push(head.readUInt32BE(12 + i * 4))
    } else if (SFNT_VERSIONS.has(head.readUInt32BE(0))) {
      offsets = [0]
    } else {
      return []
    }

    const faces: SystemFontFace[] = []
    for (let index = 0; index < offsets.length; index++) {
      const faceOffset = offsets[index]
      if (faceOffset + 12 > stat.size) continue
      // 表目录最多 256 条;首块没覆盖到(faceOffset 靠近 64KB 边界)时补读一次
      const header =
        faceOffset + 12 + 16 * 256 <= head.length
          ? head.subarray(faceOffset)
          : await readAt(handle, faceOffset, 12 + 16 * 256)
      if (header.length < 12) continue
      const version = header.readUInt32BE(0)
      if (!SFNT_VERSIONS.has(version)) continue
      const numTables = header.readUInt16BE(4)
      if (numTables === 0 || numTables > 256) continue

      let nameTable: TableRecord | null = null
      for (let i = 0; i < numTables; i++) {
        const recordAt = 12 + i * 16
        if (recordAt + 16 > header.length) break
        const tag = header.toString('ascii', recordAt, recordAt + 4)
        const tableOffset = header.readUInt32BE(recordAt + 8)
        const tableLength = header.readUInt32BE(recordAt + 12)
        if (tag !== 'name') continue
        if (tableOffset + tableLength > stat.size || tableLength === 0 || tableLength > 4 * 1024 * 1024) break
        nameTable = { tag, offset: tableOffset, length: tableLength }
        break
      }
      if (!nameTable) continue
      const nameBuffer = await readAt(handle, nameTable.offset, nameTable.length)
      const face = namesToFaces(parseNameTable(nameBuffer), file, index)
      if (face) faces.push(face)
    }
    return faces
  } catch {
    // 单个字体损坏/无权限:跳过,不影响其它字体
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** 本机字体目录(Windows 系统 + 当前用户字体;其它平台扫常见目录) */
function fontDirectories(): string[] {
  const dirs: string[] = []
  if (process.platform === 'win32') {
    dirs.push(join(process.env['WINDIR'] || 'C:\\Windows', 'Fonts'))
    const localAppData = process.env['LOCALAPPDATA']
    if (localAppData) dirs.push(join(localAppData, 'Microsoft', 'Windows', 'Fonts'))
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', join(homedir(), '.fonts'), join(homedir(), '.local/share/fonts'))
  }
  // 单测/便携环境:额外字体目录(path.delimiter 分隔)
  const extra = process.env['PDF_EDITOR_EXTRA_FONT_DIRS']
  if (extra) {
    for (const dir of extra.split(process.platform === 'win32' ? ';' : ':')) {
      if (dir.trim() !== '') dirs.push(dir.trim())
    }
  }
  return dirs
}

async function collectFontFiles(dir: string, out: string[], depth: number): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Windows 字体目录是平铺的;其它平台按深度递归,避免误入深层目录
      if (depth < 4) await collectFontFiles(full, out, depth + 1)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    out.push(full)
  }
}

/** 常规字重优先:同族有多个文件(arial.ttf / arialbd.ttf)时选 Regular */
function regularScore(face: SystemFontFace): number {
  const style = face.style.toLowerCase()
  if (/^(regular|normal|book|roman|标准|常规)$/.test(style)) return 0
  if (style.includes('regular') || style.includes('normal')) return 1
  if (style.includes('bold') || style.includes('italic') || style.includes('black') || style.includes('heavy')) return 3
  return 2
}

/** 同一字族只保留一个代表面(下拉框按字族列出,不列粗体/斜体) */
function dedupeFamilies(faces: SystemFontFace[]): SystemFontFace[] {
  const byFamily = new Map<string, SystemFontFace>()
  for (const face of faces) {
    const key = normalizeKey(face.family)
    // '@宋体' 之类是竖排/符号变体,不在下拉框里单列
    if (key === '' || key.startsWith('@')) continue
    const existing = byFamily.get(key)
    if (!existing || regularScore(face) < regularScore(existing)) byFamily.set(key, face)
  }
  return [...byFamily.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
}

async function scanFonts(): Promise<SystemFontFace[]> {
  const files: string[] = []
  for (const dir of fontDirectories()) await collectFontFiles(dir, files, 0)
  // 同一文件可能同时出现在系统/用户目录(符号链接):按真实路径名去重
  const seen = new Set<string>()
  const faces: SystemFontFace[] = []
  for (const file of files) {
    const key = normalizeKey(file)
    if (seen.has(key)) continue
    seen.add(key)
    faces.push(...(await parseFontFile(file)))
  }
  return dedupeFamilies(faces)
}

async function ensureFontList(): Promise<SystemFontFace[]> {
  if (!fontListPromise) {
    fontListPromise = scanFonts().then((faces) => {
      const map = new Map<string, SystemFontFace>()
      for (const face of faces) {
        for (const alias of face.aliases) {
          const key = normalizeKey(alias)
          if (key !== '' && !map.has(key)) map.set(key, face)
        }
      }
      // 精确字族名优先级最高:某字体的本地化名可能恰好等于另一字体的规范名
      for (const face of faces) map.set(normalizeKey(face.family), face)
      aliasMap = map
      return faces
    })
    // 扫描失败不能永久缓存一个 rejected promise:清空后下次可重试
    fontListPromise = fontListPromise.catch((err) => {
      fontListPromise = null
      throw err
    })
  }
  return fontListPromise
}

/** 渲染层字体下拉框用:按字族去重后的列表(不含路径) */
export async function listSystemFonts(): Promise<SystemFontInfo[]> {
  const faces = await ensureFontList()
  return faces.map((face) => ({ family: face.family, label: face.label }))
}

/** 按字族名/本地化名/PostScript 名查找字体;找不到返回 null */
export async function findSystemFont(family: string): Promise<SystemFontFace | null> {
  const key = normalizeKey(family)
  if (key === '') return null
  await ensureFontList()
  return aliasMap.get(key) ?? null
}

/** 测试/环境自检:清空字体列表缓存 */
export function resetSystemFontCache(): void {
  fontListPromise = null
  aliasMap = new Map()
  fontBytesCache.clear()
  fontBytesCached = 0
}

/**
 * 把 TTC/OTC 里的第 index 面抽成独立 sfnt 文件。
 * 非集合字体原样返回。抽取时重算表偏移与 head.checkSumAdjustment,
 * 否则部分实现(fontkit 之外)会因校验和不匹配拒绝加载。
 */
export function extractFaceFromCollection(bytes: Buffer, index: number): Buffer {
  if (bytes.length < 12 || bytes.readUInt32BE(0) !== TTC_TAG) return bytes
  const count = bytes.readUInt32BE(8)
  if (count === 0 || index < 0 || index >= count) throw new Error('字体集合索引越界')
  if (12 + count * 4 > bytes.length) throw new Error('字体集合头损坏')
  const faceOffset = bytes.readUInt32BE(12 + index * 4)
  if (faceOffset + 12 > bytes.length) throw new Error('字体集合表目录越界')

  const version = bytes.readUInt32BE(faceOffset)
  if (!SFNT_VERSIONS.has(version)) throw new Error('不支持的字体格式')
  const numTables = bytes.readUInt16BE(faceOffset + 4)
  if (numTables === 0 || numTables > 256) throw new Error('字体表数量异常')
  if (faceOffset + 12 + numTables * 16 > bytes.length) throw new Error('字体表目录损坏')

  const tables: Array<TableRecord & { checksum: number; newOffset: number }> = []
  for (let i = 0; i < numTables; i++) {
    const recordAt = faceOffset + 12 + i * 16
    const table: TableRecord & { checksum: number; newOffset: number } = {
      tag: bytes.toString('ascii', recordAt, recordAt + 4),
      checksum: bytes.readUInt32BE(recordAt + 4),
      offset: bytes.readUInt32BE(recordAt + 8),
      length: bytes.readUInt32BE(recordAt + 12),
      newOffset: 0
    }
    if (table.offset + table.length > bytes.length) throw new Error(`字体表 ${table.tag} 越界`)
    tables.push(table)
  }

  const align4 = (value: number): number => (value + 3) & ~3
  let total = 12 + numTables * 16
  for (const table of tables) {
    table.newOffset = total
    total += align4(table.length)
  }
  // 恶意/损坏字体的表记录可以互相重叠,让「各表长度之和」远超文件大小;
  // 抽取产物是真实字体的数据副本,不可能比源文件大一个数量级
  if (total > Math.max(bytes.length * 2, 16 * 1024 * 1024)) throw new Error('字体表数据异常')
  const out = Buffer.alloc(total)
  // sfnt 头(version/numTables/searchRange/entrySelector/rangeShift)原样保留
  bytes.copy(out, 0, faceOffset, faceOffset + 12)
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i]
    const recordAt = 12 + i * 16
    out.write(table.tag, recordAt, 4, 'ascii')
    out.writeUInt32BE(table.checksum, recordAt + 4)
    out.writeUInt32BE(table.newOffset, recordAt + 8)
    out.writeUInt32BE(table.length, recordAt + 12)
    bytes.copy(out, table.newOffset, table.offset, table.offset + table.length)
  }

  const head = tables.find((table) => table.tag === 'head')
  if (head) out.writeUInt32BE(0, head.newOffset + 8)
  let sum = 0
  for (let i = 0; i < out.length; i += 4) sum = (sum + out.readUInt32BE(i)) >>> 0
  if (head) out.writeUInt32BE((0xb1b0afba - sum) >>> 0, head.newOffset + 8)
  return out
}

/** 读取字体字节(集合字体抽取所选面);同一字体缓存,避免批量导出反复读盘 */
export async function readSystemFontBytes(face: SystemFontFace): Promise<Buffer> {
  const key = `${normalizeKey(face.file)}#${face.index}`
  const cached = fontBytesCache.get(key)
  if (cached) return cached

  const handle = await open(face.file, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size > MAX_FONT_FILE_BYTES) throw new Error(`字体文件过大:${face.file}`)
    const bytes = await readAt(handle, 0, stat.size)
    if (bytes.length !== stat.size) throw new Error(`字体文件读取不完整:${face.file}`)
    const faceBytes = extractFaceFromCollection(bytes, face.index)
    if (faceBytes.length <= FONT_BYTES_CACHE_LIMIT) {
      while (fontBytesCached + faceBytes.length > FONT_BYTES_CACHE_LIMIT && fontBytesCache.size > 0) {
        const oldestKey = fontBytesCache.keys().next().value
        if (oldestKey === undefined) break
        const oldest = fontBytesCache.get(oldestKey)
        fontBytesCache.delete(oldestKey)
        fontBytesCached -= oldest?.length ?? 0
      }
      fontBytesCache.set(key, faceBytes)
      fontBytesCached += faceBytes.length
    }
    return faceBytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}
