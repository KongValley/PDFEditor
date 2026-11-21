/**
 * 源文件格式判定(PDF / OFD / ODF / 其它)。
 *
 * OFD 与 ODF 都是 ZIP 容器,但包结构完全不同:OFD 根上有 OFD.xml,ODF 则有
 * mimetype + content.xml + META-INF/manifest.xml。ODF 另有单文件「扁平 XML」形态
 * (.fodt/.fods/.fodp),根元素带 office:mimetype。
 *
 * 判定只读中央目录与 mimetype 条目,不整包 inflate:打开对话框会用它区分类型,
 * 几百 MB 的扫描件不能为了看一眼格式就解压一遍。
 */
import { looksLikeZip, readZipEntry, zipEntryNames } from './ofd/zip'

export type DocKind = 'pdf' | 'ofd' | 'odf' | 'other'

/** ODF 的三类办公文档(图形 ODG 不在支持范围) */
export type OdfKind = 'text' | 'spreadsheet' | 'presentation'

const ODF_MIME_RE =
  /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)(?:-template|-flat-xml|\.flat-xml)?\s*$/i

/** mimetype → ODF 子类型;非 ODF/不支持的类型返回 null */
export function odfKindFromMime(mime: string | null | undefined): OdfKind | null {
  const match = ODF_MIME_RE.exec((mime ?? '').trim())
  if (!match) return null
  return match[1].toLowerCase() as OdfKind
}

function textHead(buffer: Uint8Array, length = 16 * 1024): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2, Math.min(buffer.length, 2 + length * 2)))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2, Math.min(buffer.length, 2 + length * 2)))
  }
  const start = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0
  return new TextDecoder('utf-8').decode(buffer.subarray(start, Math.min(buffer.length, start + length)))
}

/** 扁平 ODF(.fodt/.fods/.fodp):单文件 XML,根元素为 office:document 且带 office:mimetype */
function flatOdfKind(buffer: Uint8Array): OdfKind | null {
  const head = textHead(buffer)
  if (!/<(?:[\w.-]+:)?document[\s>]/.test(head)) return null
  const match = /(?:[\w.-]+:)?mimetype\s*=\s*["']([^"']+)["']/.exec(head)
  return match ? odfKindFromMime(match[1]) : null
}

/** 判源文件格式;无法识别时沿用历史行为返回 'pdf'(由后续解析给出「无法解析 PDF」) */
export function detectDocumentKind(buffer: Uint8Array): DocKind {
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'pdf'
  }
  if (looksLikeZip(buffer)) {
    try {
      const names = zipEntryNames(buffer)
      if (names.includes('OFD.xml') || names.some((name) => !name.includes('/') && name.toLowerCase() === 'ofd.xml')) {
        return 'ofd'
      }
      // ODF 规范要求 mimetype 为包内第一个条目;少数生成器会省略 manifest,
      // 但只要同时有 mimetype 与 content.xml 就足以与 docx/epub 等 ZIP 区分
      if (names.includes('content.xml') && (names.includes('mimetype') || names.includes('META-INF/manifest.xml'))) {
        return 'odf'
      }
      return 'other'
    } catch {
      return 'other'
    }
  }
  if (flatOdfKind(buffer)) return 'odf'
  return 'pdf'
}

/**
 * 已判定为 ODF 的包 → 子类型。优先读 mimetype(规范要求明文,且必须是第一个条目);
 * ZIP 里 mimetype 缺失/损坏时返回 null(调用方可继续解析 content.xml 判断),
 * 扁平 XML 则直接看根元素的 office:mimetype。
 */
export function detectOdfKind(buffer: Uint8Array): OdfKind | null {
  if (looksLikeZip(buffer)) {
    try {
      const mimeBytes = readZipEntry(buffer, 'mimetype')
      return mimeBytes ? odfKindFromMime(new TextDecoder('utf-8').decode(mimeBytes)) : null
    } catch {
      return null
    }
  }
  return flatOdfKind(buffer)
}

/** content.xml 的 office:body 直接子元素名 → 子类型(解析器会把根元素本地名传进来) */
export function kindFromBodyChild(name: string): OdfKind | null {
  switch (name) {
    case 'text':
      return 'text'
    case 'spreadsheet':
      return 'spreadsheet'
    case 'presentation':
      return 'presentation'
    default:
      return null
  }
}

/** 扁平 ODF 检测(供解析器决定读单文件还是 ZIP) */
export function isFlatOdf(buffer: Uint8Array): boolean {
  return flatOdfKind(buffer) !== null
}
