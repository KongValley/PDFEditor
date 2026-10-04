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
  sidecar?: SidecarData | null
}

export interface PageOpResult {
  ok: boolean
  error?: string
  buffer?: ArrayBuffer
  pageCount?: number
  /** pageMap[oldIndex] = newIndex | -1 */
  pageMap?: number[]
  savedPath?: string
}

/** 追加合并的单个文件:pages 为要合并的 0-based 页序;null = 全部页 */
export interface AppendFileSpec {
  path: string
  pages: number[] | null
}

/** 页面操作指令(main 侧 docops 执行) */
export type PageOp =
  | { kind: 'delete'; pages: number[] }
  | { kind: 'rotate'; pages: number[]; delta: number }
  | { kind: 'insertBlank'; afterIndex: number }
  | { kind: 'append'; files: AppendFileSpec[] }
  | { kind: 'export'; pages: number[]; targetPath: string }

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
