/**
 * 最小 ZIP 读写(OFD 容器用)。
 *
 * 为什么自己写而不是引依赖:仓库对运行时依赖极保守,而这里只需要「读中央目录 + 两种压缩方式」
 * 与「全 STORE 写入」这两件事,node:zlib 已提供 deflate/inflate 原语,合计约 200 行纯函数,
 * 可在 node 环境下直接单测(见 tests/unit/ofd-zip.test.ts)。
 *
 * 已知上限(按需再扩):
 *  - 不支持 zip64(条目数/偏移/大小出现 0xFFFF/0xFFFFFFFF 标记即报错,不静默读错数据);
 *  - 只支持存储(0)与 deflate(8),加密 ZIP(flags bit0)不处理;
 *  - 读取时以中央目录记录的长度为准,兼容 bit3(数据描述符)。
 */
import { open, readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_MARK16 = 0xffff
const ZIP64_MARK32 = 0xffffffff
const EOCD_MIN = 22
const EOCD_MAX_COMMENT = 0xffff

let crcTable: Int32Array | null = null

function table(): Int32Array {
  if (crcTable) return crcTable
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  crcTable = t
  return t
}

/** CRC-32(IEEE 802.3,ZIP/PNG 通用多项式 0xEDB88320) */
export function crc32(bytes: Uint8Array): number {
  const t = table()
  let c = -1
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** 文件头是否是 ZIP(PK\x03\x04;空包 PK\x05\x06 也认) */
export function looksLikeZip(buffer: Uint8Array): boolean {
  if (buffer.length < 4) return false
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false
  const third = buffer[2]
  return (third === 0x03 && buffer[3] === 0x04) || (third === 0x05 && buffer[3] === 0x06)
}

function u16(buffer: Uint8Array, at: number): number {
  return buffer[at] | (buffer[at + 1] << 8)
}

function u32(buffer: Uint8Array, at: number): number {
  return (buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16) | (buffer[at + 3] << 24)) >>> 0
}

interface ZipEntryMeta {
  name: string
  method: number
  compSize: number
  localOffset: number
}

/** 解析中央目录(不解压任何条目):格式判定只需条目名,不必把整包 inflate 一遍 */
function readCentralDirectory(buffer: Uint8Array): ZipEntryMeta[] {
  if (!looksLikeZip(buffer)) throw new Error('不是有效的 ZIP 文件')

  // 从尾部向前找 EOCD(注释最长 65535,故只需回扫 22+65535 字节)
  const scanFrom = Math.max(0, buffer.length - EOCD_MIN - EOCD_MAX_COMMENT)
  let eocd = -1
  for (let at = buffer.length - EOCD_MIN; at >= scanFrom; at--) {
    if (u32(buffer, at) !== EOCD_SIG) continue
    // 注释长度必须与剩余字节吻合,避免把数据里偶然出现的签名当成 EOCD
    if (at + EOCD_MIN + u16(buffer, at + 20) === buffer.length) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件(找不到中央目录结尾记录)')

  const total = u16(buffer, eocd + 10)
  const cdSize = u32(buffer, eocd + 12)
  const cdOffset = u32(buffer, eocd + 16)
  if (total === ZIP64_MARK16 || cdSize === ZIP64_MARK32 || cdOffset === ZIP64_MARK32) {
    throw new Error('zip64 不受支持,请用支持 zip64 的工具重新导出 OFD')
  }
  if (eocd >= 20 && u32(buffer, eocd - 20) === ZIP64_LOCATOR_SIG) {
    throw new Error('zip64 不受支持,请用支持 zip64 的工具重新导出 OFD')
  }
  if (cdOffset + cdSize > buffer.length) throw new Error('ZIP 中央目录越界,文件可能已损坏')

  const decoder = new TextDecoder('utf-8')
  const metas: ZipEntryMeta[] = []
  let at = cdOffset
  for (let i = 0; i < total; i++) {
    if (at + 46 > buffer.length || u32(buffer, at) !== CD_SIG) {
      throw new Error('ZIP 中央目录条目损坏')
    }
    const nameLen = u16(buffer, at + 28)
    const extraLen = u16(buffer, at + 30)
    const commentLen = u16(buffer, at + 32)
    const name = decoder.decode(buffer.subarray(at + 46, at + 46 + nameLen))
    metas.push({
      name,
      method: u16(buffer, at + 10),
      compSize: u32(buffer, at + 20),
      localOffset: u32(buffer, at + 42)
    })
    at += 46 + nameLen + extraLen + commentLen
  }
  return metas
}

/** 只取包内条目名(含目录项),不解压:用于格式判定 */
export function zipEntryNames(buffer: Uint8Array): string[] {
  return readCentralDirectory(buffer).map((meta) => meta.name)
}

/**
 * 解包:返回「包内路径 → 原始字节」。目录项(名以 / 结尾)不进结果。
 * 任何结构性问题都抛中文错误,由调用方转成用户可见提示。
 */
export function readZipEntries(buffer: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>()
  for (const meta of readCentralDirectory(buffer)) {
    if (meta.name.endsWith('/')) continue
    const { localOffset, name, compSize, method } = meta
    if (localOffset + 30 > buffer.length || u32(buffer, localOffset) !== LOCAL_SIG) {
      throw new Error(`ZIP 条目损坏:${name}`)
    }
    const localNameLen = u16(buffer, localOffset + 26)
    const localExtraLen = u16(buffer, localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const end = start + compSize
    if (end > buffer.length) throw new Error(`ZIP 条目越界:${name}`)
    const raw = buffer.subarray(start, end)
    if (method === 0) {
      entries.set(name, raw.slice())
    } else if (method === 8) {
      try {
        const out = inflateRawSync(raw)
        entries.set(name, new Uint8Array(out.buffer, out.byteOffset, out.byteLength))
      } catch (err) {
        throw new Error(`ZIP 条目解压失败:${name}(${(err as Error).message})`)
      }
    } else {
      throw new Error(`不支持的压缩方式 ${method}:${name}`)
    }
  }
  return entries
}

export interface ZipWriteEntry {
  /** 包内路径(用 / 分隔) */
  name: string
  /** 直接给出的字节(小文件,如 XML) */
  data?: Uint8Array | string
  /** 从磁盘读取的字节(大文件,如页图);与 data 二选一 */
  filePath?: string
}

/**
 * 全 STORE(不压缩)写 ZIP。OFD 里的图片本身就是压缩格式,XML 只有几 KB,
 * 用 STORE 省掉压缩开销与内存峰值;同时避免在低配机上多一次整包压缩。
 *
 * 异步写:导出 400 页 300dpi 时这一趟要搬运几百 MB,同步 I/O 会把主进程(以及窗口响应)
 * 一起卡住数秒 —— 与 atomicWrite/print.ts 一样走 fs/promises,每个条目之间让出事件循环。
 */
export async function writeZipStored(targetPath: string, entries: ZipWriteEntry[]): Promise<void> {
  const handle = await open(targetPath, 'w')
  try {
    const now = new Date()
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff
    const central: Buffer[] = []
    let offset = 0

    for (const entry of entries) {
      const nameBytes = Buffer.from(entry.name, 'utf8')
      let payload: Buffer
      if (entry.data !== undefined) {
        payload = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
      } else {
        if (!entry.filePath) throw new Error(`ZIP 条目缺少内容:${entry.name}`)
        payload = await readFile(entry.filePath)
      }
      const crc = crc32(payload)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(LOCAL_SIG, 0)
      local.writeUInt16LE(20, 4) // version needed
      local.writeUInt16LE(0x0800, 6) // flags:UTF-8 名
      local.writeUInt16LE(0, 8) // method:store
      local.writeUInt16LE(dosTime, 10)
      local.writeUInt16LE(dosDate, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(payload.length, 22)
      local.writeUInt16LE(nameBytes.length, 26)
      local.writeUInt16LE(0, 28)
      await handle.write(local)
      await handle.write(nameBytes)
      await handle.write(payload)

      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(CD_SIG, 0)
      cd.writeUInt16LE(20, 4) // version made by
      cd.writeUInt16LE(20, 6) // version needed
      cd.writeUInt16LE(0x0800, 8)
      cd.writeUInt16LE(0, 10)
      cd.writeUInt16LE(dosTime, 12)
      cd.writeUInt16LE(dosDate, 14)
      cd.writeUInt32LE(crc, 16)
      cd.writeUInt32LE(payload.length, 20)
      cd.writeUInt32LE(payload.length, 24)
      cd.writeUInt16LE(nameBytes.length, 28)
      cd.writeUInt16LE(0, 30) // extra
      cd.writeUInt16LE(0, 32) // comment
      cd.writeUInt16LE(0, 34) // disk
      cd.writeUInt16LE(0, 36) // internal attrs
      cd.writeUInt32LE(0, 38) // external attrs
      cd.writeUInt32LE(offset, 42)
      central.push(cd, nameBytes)
      offset += 30 + nameBytes.length + payload.length
    }

    const cdOffset = offset
    let cdSize = 0
    for (const chunk of central) {
      await handle.write(chunk)
      cdSize += chunk.length
    }
    const eocd = Buffer.alloc(EOCD_MIN)
    eocd.writeUInt32LE(EOCD_SIG, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdOffset, 16)
    eocd.writeUInt16LE(0, 20)
    await handle.write(eocd)
  } finally {
    await handle.close()
  }
}
