/**
 * 主进程 / 预加载 / 渲染进程共享的类型定义。
 * 注释坐标一律为 PDF 用户空间坐标(pt,原点左下,未旋转)。
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export type StampKey =
  | 'approved'
  | 'void'
  | 'reviewing'
  | 'pending'
  | 'archived'
  | 'confidential'

export type AnnotationKind =
  | 'highlight'
  | 'rect'
  | 'ellipse'
  | 'ink'
  | 'arrow'
  | 'measure'
  | 'text'
  | 'note'
  | 'image'
  | 'stamp'

export interface AnnotationBase {
  id: string
  kind: AnnotationKind
  /** 0-based 页码 */
  page: number
  /** 外接矩形(PDF 用户空间坐标);ink/arrow/measure 由几何点派生并保持同步 */
  bbox: Rect
  /** #rrggbb */
  color: string
  /** 0-1 */
  opacity: number
  createdAt: number
  /** 锁定后画布上不可拖动/缩放/编辑(属性面板不受限) */
  locked?: boolean
}

export interface HighlightAnnotation extends AnnotationBase {
  kind: 'highlight'
}

export interface RectAnnotation extends AnnotationBase {
  kind: 'rect'
  thickness: number
}

export interface EllipseAnnotation extends AnnotationBase {
  kind: 'ellipse'
  thickness: number
}

export interface InkAnnotation extends AnnotationBase {
  kind: 'ink'
  points: Point[]
  thickness: number
}

export interface ArrowAnnotation extends AnnotationBase {
  kind: 'arrow'
  from: Point
  to: Point
  thickness: number
}

export interface MeasureAnnotation extends AnnotationBase {
  kind: 'measure'
  from: Point
  to: Point
  thickness: number
  unit: 'mm'
}

export interface TextAnnotation extends AnnotationBase {
  kind: 'text'
  text: string
  fontSize: number
  /** 用户创建该注释时的显示旋转角(顺时针,0/90/180/270);保存时作为文字旋转角 */
  rotate: number
}

export interface NoteAnnotation extends AnnotationBase {
  kind: 'note'
  text: string
}

export interface ImageAnnotation extends AnnotationBase {
  kind: 'image'
  imgId: string
  /** 原始图片磁盘路径,用于会话间恢复 */
  refPath: string
}

export interface StampAnnotation extends AnnotationBase {
  kind: 'stamp'
  stampKey: StampKey
  label: string
  fontSize: number
  rotate: number
}

export type Annotation =
  | HighlightAnnotation
  | RectAnnotation
  | EllipseAnnotation
  | InkAnnotation
  | ArrowAnnotation
  | MeasureAnnotation
  | TextAnnotation
  | NoteAnnotation
  | ImageAnnotation
  | StampAnnotation

/** 计算注释外接矩形(ink/arrow/measure 依据几何点) */
export function annotationBounds(ann: Annotation): Rect {
  if (ann.kind === 'ink') {
    return pointsBounds(ann.points)
  }
  if (ann.kind === 'arrow' || ann.kind === 'measure') {
    return pointsBounds([ann.from, ann.to])
  }
  return ann.bbox
}

export function pointsBounds(points: Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'choice' | 'unknown'

export interface FormFieldInfo {
  /** 用于展示的字段名 */
  name: string
  /** 用于写回 pdf-lib 的完整字段名 */
  fullName: string
  type: FormFieldType
  /** 0-based 页码 */
  page: number
  /** PDF 用户空间坐标 */
  rect: Rect
  options?: string[]
  value?: string | boolean
  /** 层级复杂、无法可靠写回的字段(仅 sidecar 保存) */
  hierarchical?: boolean
}

export type FormValue = string | boolean

// ---------------------------------------------------------------------------
// sidecar
// ---------------------------------------------------------------------------

export interface SidecarData {
  version: number
  annotations: Annotation[]
  formValues: Record<string, FormValue>
}

// ---------------------------------------------------------------------------
// IPC 载荷
// ---------------------------------------------------------------------------

export interface OpenResult {
  ok: boolean
  error?: 'password' | 'corrupt' | 'unknown'
  errorMessage?: string
  docId?: string
  path?: string
  buffer?: ArrayBuffer
  pageCount?: number
  encrypted?: boolean
  /** 从 PDF /Annots 提取的本应用批注(加密文档为空数组) */
  annotations?: Annotation[]
  sidecar?: SidecarData | null
  /** 'range' = 渲染层按需分段读取(大文件);'buffer' = 随 IPC 传整份字节(现状) */
  stream?: 'range' | 'buffer'
  /** 文件总字节数(stream='range' 时必需) */
  fileSize?: number
}

/** 运行时机器画像(供渲染层按硬件调整上限) */
export interface RuntimeInfo {
  smoke: boolean
  version: string
  /** 'ia32' | 'x64' | 'arm64' */
  arch: string
  totalMemMB: number
  /** 物理内存 ≤ 4GB,按省内存档处理 */
  lowMem: boolean
}

/** 渲染层按需分段读取(大文件 Range 流式加载)的返回 */
export interface RangeReadResult {
  ok: boolean
  bytes?: Uint8Array
  error?: string
}

export interface PageOpResult {
  ok: boolean
  error?: string
  buffer?: ArrayBuffer
  pageCount?: number
  /** pageMap[oldIndex] = newIndex | -1 */
  pageMap?: number[]
  /** 本次页面操作是否记录了主进程快照(超大文档跳过 → 渲染层不应记入撤销栈) */
  snapshotted?: boolean
  savedPath?: string
}

/** 追加合并的单个文件:pages 为要合并的 0-based 页序;null = 全部页 */
export interface AppendFileSpec {
  path: string
  pages: number[] | null
}

/** 批量拆分任务(1-based 闭区间;两模式互斥;docId 存在时用内存 buffer) */
export type SplitTask =
  | { mode: 'maxPages'; path: string; docId?: string; start: number; end: number; pagesPerFile: number }
  | { mode: 'ranges'; path: string; docId?: string; ranges: number[][] }

export interface SplitTaskResult {
  path: string
  ok: boolean
  outputs?: string[]
  error?: string
}

/** 页面操作指令(main 侧 docops 执行) */
export type PageOp =
  | { kind: 'delete'; pages: number[] }
  | {
      kind: 'rotate'
      pages: number[]
      delta: number
      /** 逐页增量(0-based 页序 → 度数),给出时覆盖 delta;用于一次操作里混合 90/180/270 */
      deltas?: Record<number, number>
    }
  | { kind: 'insertBlank'; afterIndex: number }
  | { kind: 'move'; from: number; to: number }
  | { kind: 'append'; files: AppendFileSpec[] }
  | {
      kind: 'export'
      pages: number[]
      targetPath: string
      /** 导出是否包含注释(默认 true;false = 剥离全部批注) */
      includeAnnotations?: boolean
      /** 勾选「包含注释」时按输出页序重建的本应用批注 */
      annotations?: Annotation[]
    }

export interface SaveResult {
  ok: boolean
  canceled?: boolean
  error?: string
  savedPath?: string
  mode?: 'pdf' | 'sidecar'
  /** 保存过程中的非致命提示(字体缺失、图片丢失等) */
  warnings?: string[]
}

export interface ImageInfo {
  imgId: string
  refPath: string
  dataUrl: string
  width: number
  height: number
}

export interface ChooseFileResult {
  canceled: boolean
  paths: string[]
}

export interface OutlineNode {
  title: string
  page: number | null
  children: OutlineNode[]
}
