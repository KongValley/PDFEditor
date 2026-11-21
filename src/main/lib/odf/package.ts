/**
 * ODF 包解析(OpenDocument 1.1/1.2/1.3):ZIP → content.xml + styles.xml(+ 包内媒体),
 * 以及单文件「扁平 XML」形态(.fodt/.fods/.fodp)。
 *
 * 这里只做「拿到 XML 树与包内文件」,不理解具体排版;样式解析在 style.ts,
 * 生成 HTML 在 html.ts。与 OFD 一样走 @xmldom/xmldom(Node 16 没有内置 XML 解析)。
 */
import {
  isFlatOdf,
  kindFromBodyChild,
  odfKindFromMime,
  type OdfKind
} from '../documentkind'
import { child, children, localNameOf, parseXml, textOf } from '../ofd/model'
import { looksLikeZip, readZipEntries } from '../ofd/zip'
import { odfAttr } from './xml'

export interface OdfPackage {
  kind: OdfKind
  /** content.xml 根元素(扁平 XML 时即 office:document 本身) */
  content: Document
  /** styles.xml 根元素;缺失或扁平 XML 时为 null */
  styles: Document | null
  /** 包内文件(扁平 XML 时为空 Map) */
  files: Map<string, Uint8Array>
  /** 单文件扁平 XML(.fodt/.fods/.fodp) */
  flat: boolean
}

export type OdfPackageResult =
  | { ok: true; pkg: OdfPackage }
  | { ok: false; error: string }

const decoder = new TextDecoder('utf-8')

function decodeText(bytes: Uint8Array): string {
  // ODF 规范要求 UTF-8,但个别生成器写 UTF-16(带 BOM);不处理会把整份 XML 解成乱码
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  return decoder.decode(bytes)
}

/** office:body 的直接子元素(localName 为 text/spreadsheet/presentation) */
function bodyChildName(doc: Document): string {
  const body = child(doc.documentElement, 'body')
  if (!body) return ''
  for (let node = body.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue
    const el = node as unknown as Element
    return localNameOf(el)
  }
  return ''
}

/**
 * 解析 ODF 包。结构性缺陷抛「无法解析 ODF:」开头的中文错误;
 * 不支持的 ODF 子类型(图形 ODG、数据库等)给明确说明。
 */
export function readOdfPackage(buffer: Uint8Array): OdfPackageResult {
  try {
    if (looksLikeZip(buffer)) {
      const files = readZipEntries(buffer)
      const contentBytes = files.get('content.xml')
      if (!contentBytes) return { ok: false, error: '无法解析 ODF:包内缺少 content.xml' }
      const content = parseXml(decodeText(contentBytes))
      const stylesBytes = files.get('styles.xml')
      const styles = stylesBytes ? parseXml(decodeText(stylesBytes)) : null

      const mime = files.get('mimetype') ? decodeText(files.get('mimetype') as Uint8Array) : ''
      // 以实际 body 类型为准(mimetype 个别生成器会写错/写成模板类型)
      const kind = kindFromBodyChild(bodyChildName(content)) ?? odfKindFromMime(mime)
      if (!kind) {
        return {
          ok: false,
          error: `不支持的 ODF 文档类型(${mime.trim() || '未知'}):只支持文字(.odt)、表格(.ods)、演示(.odp)`
        }
      }
      return { ok: true, pkg: { kind, content, styles, files, flat: false } }
    }

    if (!isFlatOdf(buffer)) {
      return { ok: false, error: '无法解析 ODF:不是有效的 ODF 压缩包或扁平 XML' }
    }
    const doc = parseXml(decodeText(buffer))
    const kind =
      kindFromBodyChild(bodyChildName(doc)) ??
      odfKindFromMime(odfAttr(doc.documentElement, 'mimetype') ?? '')
    if (!kind) {
      return { ok: false, error: '不支持的 ODF 文档类型:只支持文字(.fodt)、表格(.fods)、演示(.fodp)' }
    }
    return { ok: true, pkg: { kind, content: doc, styles: null, files: new Map(), flat: true } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message.startsWith('无法解析 ODF') ? message : `无法解析 ODF:${message}` }
  }
}

/** 包内文件路径规范化(去掉 ./ 与 URI 转义);无法解析转义时保留原串 */
export function normalizePackagePath(href: string): string {
  let path = href.trim().replace(/\\/g, '/')
  if (path.startsWith('./')) path = path.slice(2)
  try {
    path = decodeURIComponent(path)
  } catch {
    // 非法 % 转义:按原文查找
  }
  return path.replace(/^\/+/, '')
}

/** 取包内媒体字节(扁平 XML 由调用方从 office:binary-data 读) */
export function packageFile(pkg: OdfPackage, href: string): Uint8Array | null {
  return pkg.files.get(normalizePackagePath(href)) ?? null
}

/** 文档标题(meta.xml 的 office:meta/dc:title;扁平 XML 则直接读根下的 office:meta) */
export function readOdfTitle(pkg: OdfPackage): string {
  const readMeta = (root: Element): string => {
    const officeMeta = child(root, 'meta')
    const title = officeMeta ? child(officeMeta, 'title') : null
    return title ? textOf(title) : ''
  }
  const metaBytes = pkg.files.get('meta.xml')
  if (metaBytes) {
    try {
      return readMeta(parseXml(decodeText(metaBytes)).documentElement)
    } catch {
      return ''
    }
  }
  return pkg.flat ? readMeta(pkg.content.documentElement) : ''
}

/** 供 html.ts 复用:body 元素 */
export function odfBody(pkg: OdfPackage): Element | null {
  return child(pkg.content.documentElement, 'body')
}

/** 供 html.ts 复用:body 下的文档根(text/spreadsheet/presentation) */
export function odfBodyRoot(pkg: OdfPackage): Element | null {
  const body = odfBody(pkg)
  if (!body) return null
  return children(body, pkg.kind === 'text' ? 'text' : pkg.kind === 'spreadsheet' ? 'spreadsheet' : 'presentation')[0] ?? null
}
