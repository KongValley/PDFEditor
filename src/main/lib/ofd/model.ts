/**
 * OFD 包解析(GB/T 33190-2016):ZIP → 结构化数据模型。
 *
 * 只覆盖本项目要用的部分:页面/图层、文字、图形、图像、模板页、资源(字体/多媒体/绘制参数)。
 * 数字签名、注释、动作、附件、复合对象、颜色空间/渐变一律不解析。
 * 单位:页面空间与对象空间都是毫米,原点左上、Y 向下(见规范 8.1.3/8.1.4)。
 */
import { DOMParser } from '@xmldom/xmldom'
import { looksLikeZip, readZipEntries, zipEntryNames } from './zip'

export type DocKind = 'pdf' | 'ofd' | 'other'

export interface OfdBox {
  x: number
  y: number
  w: number
  h: number
}

/** 变换矩阵 [a b c d e f],按规范 8.1.5:x' = a·x + c·y + e,y' = b·x + d·y + f */
export interface OfdMatrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** 已归一化到 0..1 的颜色 */
export interface OfdColor {
  r: number
  g: number
  b: number
  alpha: number
}

export interface OfdFontRes {
  id: string
  fontName: string
  familyName: string
  charset: string
  /** 内嵌字体在包内的路径(无前导 /);未内嵌为 null */
  fontFile: string | null
}

export interface OfdImageRes {
  id: string
  format: string
  /** 图片在包内的路径(无前导 /) */
  path: string
}

export interface OfdDrawParam {
  relative: string | null
  lineWidth?: number
  cap?: string
  join?: string
  miterLimit?: number
  dashPattern?: number[]
  dashOffset?: number
  fillColor?: OfdColor
  strokeColor?: OfdColor
}

export interface OfdTextCode {
  x?: number
  y?: number
  deltaX?: number[]
  deltaY?: number[]
  /** DeltaX/DeltaY 里出现非数字 token(部分生成器写 `g N v` 之类的缩写):整段不可用,绘制时退回字体自然步进 */
  deltaInvalid?: boolean
  text: string
}

export interface OfdTextObject {
  kind: 'text'
  id: string
  boundary: OfdBox
  fontId: string
  /** 字号(mm) */
  size: number
  hScale: number
  /** 是否勾边(规范默认 false)。绘制侧不实现文字描边,仅用于告警 */
  stroke: boolean
  readDirection: number
  charDirection: number
  fillColor: OfdColor | null
  opacity: number
  drawParamId: string | null
  ctm: OfdMatrix | null
  codes: OfdTextCode[]
}

export type OfdPathCommandOp = 'M' | 'L' | 'Q' | 'B' | 'A' | 'C'

export interface OfdPathCommand {
  op: OfdPathCommandOp
  args: number[]
}

export interface OfdPathObject {
  kind: 'path'
  id: string
  boundary: OfdBox
  commands: OfdPathCommand[]
  fill: boolean
  stroke: boolean
  rule: 'NonZero' | 'Even-Odd'
  fillColor: OfdColor | null
  strokeColor: OfdColor
  /** 线宽(mm) */
  lineWidth: number
  cap: string
  join: string
  miterLimit: number
  dashPattern: number[]
  dashOffset: number
  opacity: number
  drawParamId: string | null
  ctm: OfdMatrix | null
}

export interface OfdImageObject {
  kind: 'image'
  id: string
  boundary: OfdBox
  resourceId: string
  opacity: number
  drawParamId: string | null
  ctm: OfdMatrix | null
}

export type OfdObject = OfdTextObject | OfdPathObject | OfdImageObject

export interface OfdLayer {
  drawParamId: string | null
  objects: OfdObject[]
}

export interface OfdTemplateRef {
  id: string
  zOrder: 'Background' | 'Foreground'
}

/** 注释(规范 15 章):签章/水印/链接等,呈现内容在 Appearance 页面块里 */
export interface OfdAnnot {
  id: string
  type: string
  subtype: string
  visible: boolean
  /** Appearance 自身没有可绘制内容时(仅签名引用)记 true,绘制侧据此告警 */
  emptyAppearance: boolean
  objects: OfdObject[]
}

export interface OfdPage {
  id: string
  box: OfdBox
  layers: OfdLayer[]
  templates: OfdTemplateRef[]
  /** 该页的注释(签章/水印等),按声明顺序,绘制在页面内容之后 */
  annots: OfdAnnot[]
}

export interface OfdPackage {
  box: OfdBox
  pages: OfdPage[]
  fonts: Map<string, OfdFontRes>
  images: Map<string, OfdImageRes>
  drawParams: Map<string, OfdDrawParam>
  /** 模板页 ID → 内容文件路径 */
  templates: Map<string, string>
  /** 模板页 ID → 已解析内容(绘制顺序由 OfdPage.templates 的 ZOrder 决定) */
  templatePages: Map<string, OfdPage>
}

// ---------------------------------------------------------------------------
// 格式判定
// ---------------------------------------------------------------------------

/**
 * 判源文件格式:
 * - PDF 头 → 'pdf'
 * - ZIP 且包根有 OFD.xml → 'ofd'
 * - 是 ZIP 但没有 OFD.xml(或 ZIP 本身读不了)→ 'other'
 * - 其余 → 'pdf'(沿用现有「无法解析 PDF」报错路径,行为与改造前一致)
 */
export function detectDocumentKind(buffer: Uint8Array): DocKind {
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'pdf'
  }
  if (!looksLikeZip(buffer)) return 'pdf'
  try {
    const names = zipEntryNames(buffer)
    if (names.includes('OFD.xml')) return 'ofd'
    return names.some((name) => !name.includes('/') && name.toLowerCase() === 'ofd.xml') ? 'ofd' : 'other'
  } catch {
    return 'other'
  }
}

// ---------------------------------------------------------------------------
// XML 小工具(元素节点用命名空间,属性不用;前缀 ofd: 一律忽略)
// ---------------------------------------------------------------------------

const ELEMENT_NODE = 1

/** 取元素本地名并剥掉命名空间前缀(xmldom 是否已解析前缀都适用) */
function localNameOf(node: { localName?: string | null; nodeName: string }): string {
  const name = node.localName ?? node.nodeName
  const colon = name.indexOf(':')
  return colon >= 0 ? name.slice(colon + 1) : name
}

export function parseXml(text: string): Document {
  const parser = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (msg: string) => {
        throw new Error(`XML 解析失败:${msg}`)
      },
      fatalError: (msg: string) => {
        throw new Error(`XML 解析失败:${msg}`)
      }
    }
  })
  return parser.parseFromString(text, 'text/xml')
}

/** 直接子元素(按本地名过滤) */
export function children(el: Element, name: string): Element[] {
  const out: Element[] = []
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== ELEMENT_NODE) continue
    const element = node as unknown as Element
    if (localNameOf(element) === name) out.push(element)
  }
  return out
}

export function child(el: Element, name: string): Element | null {
  return children(el, name)[0] ?? null
}

/** 子元素的文本内容(不存在返回 null) */
export function childText(el: Element, name: string): string | null {
  const target = child(el, name)
  return target ? textOf(target) : null
}

export function textOf(el: Element): string {
  return (el.textContent ?? '').trim()
}

export function attr(el: Element, name: string): string | null {
  const value = el.getAttribute(name)
  return value === null || value === '' ? null : value
}

export function numList(value: string | null): number[] {
  if (!value) return []
  return value
    .trim()
    .split(/\s+/)
    .map((token) => Number(token))
    .filter((n) => Number.isFinite(n))
}

/**
 * 字间距数组解析。真实生成器(DLTech21/ofd.js、ofd-tools)在 DeltaX/DeltaY 里用游程写法
 * `g <次数> <值>` 表示「该值重复 N 次」(规范表 46 只写了「数组」,示例里就是这个写法),
 * 因此这里必须支持;出现无法识别的 token 时整体作废(调用方退回字体自然步进并告警),
 * 不能像 numList 那样静默丢弃 —— 那会把重复次数当成第一个字型的偏移,整行错位。
 */
function parseDelta(value: string | null): { nums: number[]; invalid: boolean } {
  if (!value) return { nums: [], invalid: false }
  const tokens = value.trim().split(/\s+/).filter(Boolean)
  const nums: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === 'g' || token === 'G') {
      const count = Number(tokens[i + 1])
      const repeated = Number(tokens[i + 2])
      // 上限防止畸形文件用超大次数撑爆内存(不可信输入)
      if (!Number.isInteger(count) || count < 0 || count > 100000 || !Number.isFinite(repeated)) {
        return { nums: [], invalid: true }
      }
      for (let k = 0; k < count; k++) nums.push(repeated)
      i += 2
      continue
    }
    const num = Number(token)
    if (!Number.isFinite(num)) return { nums: [], invalid: true }
    nums.push(num)
  }
  return { nums, invalid: false }
}

export function boxOf(value: string | null): OfdBox | null {
  const nums = numList(value)
  if (nums.length < 4) return null
  const [x, y, w, h] = nums
  if (!(w > 0) || !(h > 0)) return null
  return { x, y, w, h }
}

export function matrixOf(value: string | null): OfdMatrix | null {
  const nums = numList(value)
  if (nums.length < 6) return null
  return { a: nums[0], b: nums[1], c: nums[2], d: nums[3], e: nums[4], f: nums[5] }
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

/** ST_Loc 解析:以 / 开头视为包根绝对,否则相对 baseDir;结果去掉前导 / 并消解 . 与 .. */
export function resolveLoc(baseDir: string, loc: string): string {
  const raw = loc.trim()
  const joined = !raw ? baseDir : raw.startsWith('/') ? raw : baseDir ? `${baseDir}/${raw}` : raw
  const parts: string[] = []
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/')
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** CT_Color:Value 支持 1 值(灰)/3 值(RGB 0-255)/4 值(CMYK 0-255);alpha 为 0-255 */
export function colorOf(value: string | null, alpha: number): OfdColor | null {
  if (!value) return null
  const nums = numList(value)
  const a = clamp01(alpha / 255)
  if (nums.length === 1) {
    const gray = clamp01(nums[0] / 255)
    return { r: gray, g: gray, b: gray, alpha: a }
  }
  if (nums.length === 3) {
    return { r: clamp01(nums[0] / 255), g: clamp01(nums[1] / 255), b: clamp01(nums[2] / 255), alpha: a }
  }
  if (nums.length === 4) {
    const [c, m, y, k] = nums.map((n) => clamp01(n / 255))
    return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k), alpha: a }
  }
  return null
}

/** 紧缩路径数据:操作符决定后续操作数个数(规范表 36);S 与 M 都产出 'M' */
const PATH_ARITY: Record<string, number> = { S: 2, M: 2, L: 2, Q: 4, B: 6, A: 7, C: 0 }

export function parseAbbreviatedData(data: string): OfdPathCommand[] {
  const tokens = data.trim().split(/[\s,]+/).filter(Boolean)
  const out: OfdPathCommand[] = []
  let at = 0
  while (at < tokens.length) {
    const operator = tokens[at].toUpperCase()
    const arity = PATH_ARITY[operator]
    if (arity === undefined) throw new Error(`路径数据无效:${tokens[at]}`)
    at++
    const args: number[] = []
    for (let i = 0; i < arity; i++) {
      const token = tokens[at + i]
      const value = Number(token)
      if (token === undefined || !Number.isFinite(value)) throw new Error(`路径数据无效:${token ?? '缺少操作数'}`)
      args.push(value)
    }
    at += arity
    out.push({ op: operator === 'S' ? 'M' : (operator as OfdPathCommandOp), args })
  }
  return out
}

/** TextCode 文本:解码 \XXXX 十六进制转义(XML 实体已由解析器处理) */
export function unescapeTextCode(text: string): string {
  return text.replace(/\\([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

// ---------------------------------------------------------------------------
// 包解析
// ---------------------------------------------------------------------------

function parseDrawParam(el: Element): OfdDrawParam {
  const param: OfdDrawParam = { relative: attr(el, 'Relative') }
  const lineWidth = Number(attr(el, 'LineWidth'))
  if (Number.isFinite(lineWidth)) param.lineWidth = lineWidth
  const cap = attr(el, 'Cap')
  if (cap) param.cap = cap
  const join = attr(el, 'Join')
  if (join) param.join = join
  const miterLimit = Number(attr(el, 'MiterLimit'))
  if (Number.isFinite(miterLimit)) param.miterLimit = miterLimit
  const dashPattern = numList(attr(el, 'DashPattern'))
  if (dashPattern.length > 0) param.dashPattern = dashPattern
  const dashOffset = Number(attr(el, 'DashOffset'))
  if (Number.isFinite(dashOffset)) param.dashOffset = dashOffset
  const fillEl = child(el, 'FillColor')
  const strokeEl = child(el, 'StrokeColor')
  if (fillEl) param.fillColor = colorOf(attr(fillEl, 'Value'), Number(attr(fillEl, 'Alpha') ?? 255)) ?? undefined
  if (strokeEl) param.strokeColor = colorOf(attr(strokeEl, 'Value'), Number(attr(strokeEl, 'Alpha') ?? 255)) ?? undefined
  return param
}

/** 绘制参数继承链:基参数先,自身属性覆盖(规范 8.2.1 的「基础绘制参数」) */
function resolveDrawParam(
  params: Map<string, OfdDrawParam>,
  id: string | null,
  seen: Set<string> = new Set()
): OfdDrawParam | null {
  if (!id || seen.has(id)) return null
  seen.add(id)
  const own = params.get(id)
  if (!own) return null
  const base = resolveDrawParam(params, own.relative, seen)
  return base ? { ...base, ...own } : own
}

interface ObjectContext {
  params: Map<string, OfdDrawParam>
  layerParam: OfdDrawParam | null
  /** 解析期告警(畸形对象被跳过等),由 parseOfdPackage 的调用方提供 */
  warnings: string[]
}

/** 就近原则取值:对象自有属性 > 对象引用的 DrawParam > 图层 DrawParam > 规范默认值 */
function pickNumber(
  own: string | null,
  objectParam: OfdDrawParam | null,
  layerParam: OfdDrawParam | null,
  key: 'lineWidth' | 'miterLimit' | 'dashOffset',
  fallback: number
): number {
  if (own !== null) {
    const value = Number(own)
    if (Number.isFinite(value)) return value
  }
  const fromObject = objectParam?.[key]
  if (typeof fromObject === 'number') return fromObject
  const fromLayer = layerParam?.[key]
  if (typeof fromLayer === 'number') return fromLayer
  return fallback
}

function pickString(
  own: string | null,
  objectParam: OfdDrawParam | null,
  layerParam: OfdDrawParam | null,
  key: 'cap' | 'join',
  fallback: string
): string {
  return own ?? objectParam?.[key] ?? layerParam?.[key] ?? fallback
}

function pickColor(
  own: OfdColor | null,
  objectParam: OfdDrawParam | null,
  layerParam: OfdDrawParam | null,
  key: 'fillColor' | 'strokeColor'
): OfdColor | null {
  return own ?? objectParam?.[key] ?? layerParam?.[key] ?? null
}

function colorAlpha(el: Element, fallback: number): number {
  const raw = attr(el, 'Alpha')
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function parseTextObject(el: Element, ctx: ObjectContext, layerParamId: string | null): OfdTextObject | null {
  const boundary = boxOf(attr(el, 'Boundary'))
  const fontId = attr(el, 'Font')
  if (!boundary || !fontId) return null
  const drawParamId = attr(el, 'DrawParam') ?? layerParamId
  const objectParam = resolveDrawParam(ctx.params, attr(el, 'DrawParam'))
  const layerParam = ctx.layerParam
  const size = Number(attr(el, 'Size'))
  const fillEl = child(el, 'FillColor')
  const alpha = colorAlpha(el, 255)
  const fillColor = pickColor(
    fillEl ? colorOf(attr(fillEl, 'Value'), colorAlpha(fillEl, alpha)) : null,
    objectParam,
    layerParam,
    'fillColor'
  )
  const hScale = Number(attr(el, 'HScale'))
  const readDirection = Number(attr(el, 'ReadDirection'))
  const charDirection = Number(attr(el, 'CharDirection'))
  const codes: OfdTextCode[] = []
  for (const codeEl of children(el, 'TextCode')) {
    const x = Number(attr(codeEl, 'X'))
    const y = Number(attr(codeEl, 'Y'))
    const code: OfdTextCode = { text: unescapeTextCode(textOf(codeEl)) }
    if (Number.isFinite(x)) code.x = x
    if (Number.isFinite(y)) code.y = y
    const deltaX = parseDelta(attr(codeEl, 'DeltaX'))
    const deltaY = parseDelta(attr(codeEl, 'DeltaY'))
    if (deltaX.nums.length > 0 && !deltaX.invalid) code.deltaX = deltaX.nums
    if (deltaY.nums.length > 0 && !deltaY.invalid) code.deltaY = deltaY.nums
    if (deltaX.invalid || deltaY.invalid) code.deltaInvalid = true
    codes.push(code)
  }
  return {
    kind: 'text',
    id: attr(el, 'ID') ?? '',
    boundary,
    fontId,
    // 规范未给 Size 默认值;按 10pt 等值毫米兜底,避免整段文字缩成 0 号字
    size: Number.isFinite(size) && size > 0 ? size : 3.5278,
    hScale: Number.isFinite(hScale) && hScale > 0 ? hScale : 1,
    stroke: (attr(el, 'Stroke') ?? 'false') === 'true',
    readDirection: Number.isFinite(readDirection) ? readDirection : 0,
    charDirection: Number.isFinite(charDirection) ? charDirection : 0,
    fillColor: fillColor ?? { r: 0, g: 0, b: 0, alpha: 1 },
    opacity: clamp01(alpha / 255),
    drawParamId,
    ctm: matrixOf(attr(el, 'CTM')),
    codes
  }
}

function parsePathObject(el: Element, ctx: ObjectContext, layerParamId: string | null): OfdPathObject | null {
  const boundary = boxOf(attr(el, 'Boundary'))
  const data = childText(el, 'AbbreviatedData')
  if (!boundary || !data) return null
  const objectParam = resolveDrawParam(ctx.params, attr(el, 'DrawParam'))
  const layerParam = ctx.layerParam
  const fillEl = child(el, 'FillColor')
  const strokeEl = child(el, 'StrokeColor')
  const alpha = colorAlpha(el, 255)
  const fill = (attr(el, 'Fill') ?? 'true') !== 'false'
  const stroke = (attr(el, 'Stroke') ?? 'true') !== 'false'
  const dashPattern = numList(attr(el, 'DashPattern'))
  let commands: OfdPathCommand[]
  try {
    commands = parseAbbreviatedData(data)
  } catch (err) {
    // 单个畸形图形不能让整篇打不开:跳过该对象并如实告警(规范外的操作符/缺操作数都走这里)
    ctx.warnings.push(`图形数据无法解析,已跳过该图形(${(err as Error).message})`)
    return null
  }
  return {
    kind: 'path',
    id: attr(el, 'ID') ?? '',
    boundary,
    commands,
    fill,
    stroke,
    rule: (attr(el, 'Rule') ?? 'NonZero').toLowerCase().startsWith('even') ? 'Even-Odd' : 'NonZero',
    fillColor: pickColor(
      fillEl ? colorOf(attr(fillEl, 'Value'), colorAlpha(fillEl, alpha)) : null,
      objectParam,
      layerParam,
      'fillColor'
    ),
    strokeColor:
      pickColor(
        strokeEl ? colorOf(attr(strokeEl, 'Value'), colorAlpha(strokeEl, alpha)) : null,
        objectParam,
        layerParam,
        'strokeColor'
      ) ?? { r: 0, g: 0, b: 0, alpha: 1 },
    lineWidth: pickNumber(attr(el, 'LineWidth'), objectParam, layerParam, 'lineWidth', 0.353),
    cap: pickString(attr(el, 'Cap'), objectParam, layerParam, 'cap', 'Butt'),
    join: pickString(attr(el, 'Join'), objectParam, layerParam, 'join', 'Miter'),
    miterLimit: pickNumber(attr(el, 'MiterLimit'), objectParam, layerParam, 'miterLimit', 3.528),
    dashPattern: dashPattern.length > 0 ? dashPattern : (objectParam?.dashPattern ?? layerParam?.dashPattern ?? []),
    dashOffset: pickNumber(attr(el, 'DashOffset'), objectParam, layerParam, 'dashOffset', 0),
    opacity: clamp01(alpha / 255),
    drawParamId: attr(el, 'DrawParam') ?? layerParamId,
    ctm: matrixOf(attr(el, 'CTM'))
  }
}

function parseImageObject(el: Element, layerParamId: string | null): OfdImageObject | null {
  const boundary = boxOf(attr(el, 'Boundary'))
  // 规范表格误写成 ResouceID,XML 里两种写法都见过
  const resourceId = attr(el, 'ResourceID') ?? attr(el, 'ResouceID')
  if (!boundary || !resourceId) return null
  return {
    kind: 'image',
    id: attr(el, 'ID') ?? '',
    boundary,
    resourceId,
    opacity: clamp01(colorAlpha(el, 255) / 255),
    drawParamId: attr(el, 'DrawParam') ?? layerParamId,
    ctm: matrixOf(attr(el, 'CTM'))
  }
}

/** 收集容器(图层/页面块)里的图元对象;必须按文档顺序遍历,否则会画错遮挡关系(背景图盖住文字) */
function collectObjects(container: Element, ctx: ObjectContext, layerParamId: string | null, out: OfdObject[]): void {
  for (let node = container.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== ELEMENT_NODE) continue
    const el = node as unknown as Element
    switch (localNameOf(el)) {
      case 'TextObject': {
        const object = parseTextObject(el, ctx, layerParamId)
        if (object) out.push(object)
        break
      }
      case 'PathObject': {
        const object = parsePathObject(el, ctx, layerParamId)
        if (object) out.push(object)
        break
      }
      case 'ImageObject': {
        const object = parseImageObject(el, layerParamId)
        if (object) out.push(object)
        break
      }
      case 'PageBlock': {
        // 页面块自身可带 DrawParam,块内对象未显式指定时继承它
        const blockParam = attr(el, 'DrawParam') ?? layerParamId
        collectObjects(
          el,
          {
            params: ctx.params,
            layerParam: resolveDrawParam(ctx.params, blockParam) ?? ctx.layerParam,
            warnings: ctx.warnings
          },
          blockParam,
          out
        )
        break
      }
      default:
        break
    }
  }
}

function parsePageContent(
  xml: Document,
  fallbackBox: OfdBox,
  id: string,
  params: Map<string, OfdDrawParam>,
  warnings: string[]
): OfdPage {
  const root = xml.documentElement
  const area = child(root, 'Area')
  const box = (area ? boxOf(childText(area, 'PhysicalBox')) : null) ?? fallbackBox
  const templates: OfdTemplateRef[] = []
  for (const el of children(root, 'Template')) {
    const templateId = attr(el, 'TemplateID') ?? attr(el, 'ID')
    if (!templateId) continue
    templates.push({ id: templateId, zOrder: (attr(el, 'ZOrder') ?? 'Background') === 'Foreground' ? 'Foreground' : 'Background' })
  }
  const layers: OfdLayer[] = []
  const content = child(root, 'Content')
  const layerEls = content ? children(content, 'Layer') : children(root, 'Layer')
  for (const layerEl of layerEls) {
    const drawParamId = attr(layerEl, 'DrawParam')
    const objects: OfdObject[] = []
    collectObjects(
      layerEl,
      { params, layerParam: resolveDrawParam(params, drawParamId), warnings },
      drawParamId,
      objects
    )
    layers.push({ drawParamId, objects })
  }
  return { id, box, layers, templates, annots: [] }
}

/**
 * 解析分页注释文件(规范 15.2):Appearance 是页面块,其子对象坐标相对 Appearance 的
 * Boundary(与 ofd-tools 的渲染方式一致:Appearance 建容器 div,子对象在其内部定位),
 * 因此这里把子对象整体平移 Appearance 的原点。
 */
function parsePageAnnots(xml: Document, params: Map<string, OfdDrawParam>, warnings: string[]): OfdAnnot[] {
  const annots: OfdAnnot[] = []
  for (const annotEl of children(xml.documentElement, 'Annot')) {
    const appearance = child(annotEl, 'Appearance')
    const objects: OfdObject[] = []
    if (appearance) {
      const raw: OfdObject[] = []
      collectObjects(appearance, { params, layerParam: null, warnings }, null, raw)
      const offset = boxOf(attr(appearance, 'Boundary'))
      const dx = offset?.x ?? 0
      const dy = offset?.y ?? 0
      for (const object of raw) {
        object.boundary = { ...object.boundary, x: object.boundary.x + dx, y: object.boundary.y + dy }
        objects.push(object)
      }
    }
    annots.push({
      id: attr(annotEl, 'ID') ?? '',
      type: attr(annotEl, 'Type') ?? '',
      subtype: attr(annotEl, 'Subtype') ?? '',
      visible: (attr(annotEl, 'Visible') ?? 'true') !== 'false',
      emptyAppearance: objects.length === 0,
      objects
    })
  }
  return annots
}

function parseResFile(
  xml: Document,
  resPath: string,
  fonts: Map<string, OfdFontRes>,
  images: Map<string, OfdImageRes>,
  drawParams: Map<string, OfdDrawParam>
): void {
  const resEl = xml.documentElement
  const baseDir = resolveLoc(dirOf(resPath), attr(resEl, 'BaseLoc') ?? '')
  for (const fontsEl of children(resEl, 'Fonts')) {
    for (const fontEl of children(fontsEl, 'Font')) {
      const id = attr(fontEl, 'ID')
      if (!id) continue
      const fontFile = childText(fontEl, 'FontFile')
      fonts.set(id, {
        id,
        fontName: attr(fontEl, 'FontName') ?? '',
        familyName: attr(fontEl, 'FamilyName') ?? '',
        charset: attr(fontEl, 'Charset') ?? 'unicode',
        fontFile: fontFile ? resolveLoc(baseDir, fontFile) : null
      })
    }
  }
  for (const mediasEl of children(resEl, 'MultiMedias')) {
    for (const mediaEl of children(mediasEl, 'MultiMedia')) {
      const id = attr(mediaEl, 'ID')
      if (!id) continue
      if ((attr(mediaEl, 'Type') ?? 'Image') !== 'Image') continue
      const file = childText(mediaEl, 'MediaFile')
      if (!file) continue
      images.set(id, { id, format: (attr(mediaEl, 'Format') ?? '').toUpperCase(), path: resolveLoc(baseDir, file) })
    }
  }
  for (const paramsEl of children(resEl, 'DrawParams')) {
    for (const paramEl of children(paramsEl, 'DrawParam')) {
      const id = attr(paramEl, 'ID')
      if (!id) continue
      drawParams.set(id, parseDrawParam(paramEl))
    }
  }
}

/**
 * 解析整个 OFD 包。任何结构性缺陷都抛中文错误(以「无法解析 OFD:」开头),
 * 由调用方转成用户可见提示。资源文件缺失不抛错(缺字体/图片由绘制阶段降级并告警)。
 */
export function parseOfdPackage(zip: Map<string, Uint8Array>, warnings: string[] = []): OfdPackage {
  const decoder = new TextDecoder('utf-8')
  const readXml = (path: string): Document => {
    const bytes = zip.get(path)
    if (!bytes) throw new Error(`无法解析 OFD:包内缺少 ${path}`)
    return parseXml(decoder.decode(bytes))
  }

  const rootEl = readXml('OFD.xml').documentElement
  // 一个包可含多份版式文档(DocBody 可重复);这里只取第一份,与常见阅读器一致
  const body = child(rootEl, 'DocBody')
  const docRootLoc = body ? childText(body, 'DocRoot') : null
  if (!docRootLoc) throw new Error('无法解析 OFD:缺少 DocBody/DocRoot')

  const documentPath = resolveLoc('', docRootLoc)
  const docEl = readXml(documentPath).documentElement
  const commonData = child(docEl, 'CommonData')
  const pageArea = commonData ? child(commonData, 'PageArea') : null
  const box = boxOf(pageArea ? childText(pageArea, 'PhysicalBox') : null)
  if (!box) throw new Error('无法解析 OFD:缺少 PageArea/PhysicalBox')

  const fonts = new Map<string, OfdFontRes>()
  const images = new Map<string, OfdImageRes>()
  const drawParams = new Map<string, OfdDrawParam>()
  const baseDir = dirOf(documentPath)
  if (commonData) {
    for (const ref of [...children(commonData, 'PublicRes'), ...children(commonData, 'DocumentRes')]) {
      const resPath = resolveLoc(baseDir, textOf(ref))
      // 资源文件缺失时跳过:字体/图片缺失由绘制阶段降级,不让整篇打不开
      const bytes = zip.get(resPath)
      if (bytes) parseResFile(parseXml(decoder.decode(bytes)), resPath, fonts, images, drawParams)
    }
  }

  const templates = new Map<string, string>()
  const templatePages = new Map<string, OfdPage>()
  if (commonData) {
    for (const el of children(commonData, 'TemplatePage')) {
      const id = attr(el, 'ID')
      const loc = attr(el, 'BaseLoc')
      if (!id || !loc) continue
      const path = resolveLoc(baseDir, loc)
      templates.set(id, path)
      const bytes = zip.get(path)
      if (bytes) templatePages.set(id, parsePageContent(parseXml(decoder.decode(bytes)), box, id, drawParams, warnings))
    }
  }

  // 注释(签章/水印等)先按 PageID 收好,页解析完再挂到对应页上
  const annotsByPage = new Map<string, OfdAnnot[]>()
  for (const ref of children(docEl, 'Annotations')) {
    const indexRel = textOf(ref)
    if (!indexRel) continue
    const indexPath = resolveLoc(baseDir, indexRel)
    const indexBytes = zip.get(indexPath)
    if (!indexBytes) continue
    for (const pageEl of children(parseXml(decoder.decode(indexBytes)).documentElement, 'Page')) {
      const pageId = attr(pageEl, 'PageID')
      const fileLoc = childText(pageEl, 'FileLoc')
      if (!pageId || !fileLoc) continue
      const annotPath = resolveLoc(dirOf(indexPath), fileLoc)
      const annotBytes = zip.get(annotPath)
      if (!annotBytes) {
        warnings.push(`注释文件缺失(${annotPath}),该页签章/水印未保留`)
        continue
      }
      const parsed = parsePageAnnots(parseXml(decoder.decode(annotBytes)), drawParams, warnings)
      if (parsed.length > 0) annotsByPage.set(pageId, [...(annotsByPage.get(pageId) ?? []), ...parsed])
    }
  }

  const pagesEl = child(docEl, 'Pages')
  if (!pagesEl) throw new Error('无法解析 OFD:缺少 Pages')
  const pages: OfdPage[] = []
  for (const pageEl of children(pagesEl, 'Page')) {
    const id = attr(pageEl, 'ID') ?? String(pages.length + 1)
    const loc = attr(pageEl, 'BaseLoc')
    if (!loc) throw new Error('无法解析 OFD:页面缺少 BaseLoc')
    const resolved = resolveLoc(baseDir, loc)
    // 真实文件两种写法都有:BaseLoc 直接指 Content.xml,或指页面目录
    const path = zip.has(resolved) ? resolved : zip.has(`${resolved}/Content.xml`) ? `${resolved}/Content.xml` : null
    if (!path) throw new Error(`无法解析 OFD:页面内容不在包内(${loc})`)
    const page = parsePageContent(parseXml(decoder.decode(zip.get(path) as Uint8Array)), box, id, drawParams, warnings)
    page.annots = annotsByPage.get(id) ?? []
    pages.push(page)
  }
  if (pages.length === 0) throw new Error('无法解析 OFD:文档没有页面')

  return { box, pages, fonts, images, drawParams, templates, templatePages }
}

/** 便捷入口:一次性解包 + 解析 */
export function readOfdPackage(buffer: Uint8Array, warnings: string[] = []): OfdPackage {
  return parseOfdPackage(readZipEntries(buffer), warnings)
}
