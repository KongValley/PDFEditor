import type { Annotation, StampKey } from '@shared/types'

/** 图章预设(文字 + 颜色) */
export const STAMPS: Record<StampKey, { label: string; color: string }> = {
  approved: { label: '已批准', color: '#2f9e44' },
  void: { label: '作废', color: '#e03131' },
  reviewing: { label: '审核中', color: '#f08c00' },
  pending: { label: '待复核', color: '#1971c2' },
  archived: { label: '已归档', color: '#7048e8' },
  confidential: { label: '机密', color: '#c92a2a' }
}

export const STAMP_KEYS = Object.keys(STAMPS) as StampKey[]

/** 属性面板色板 */
export const PALETTE = [
  '#e03131',
  '#f08c00',
  '#2f9e44',
  '#1971c2',
  '#7048e8',
  '#212529',
  '#ffe066',
  '#f7a1c4'
]

export interface ToolStyle {
  color: string
  opacity: number
  thickness: number
  fontSize: number
}

export const TOOL_DEFAULTS: Record<string, ToolStyle> = {
  highlight: { color: '#ffe066', opacity: 0.4, thickness: 1, fontSize: 14 },
  rect: { color: '#e03131', opacity: 1, thickness: 1.5, fontSize: 14 },
  ellipse: { color: '#e03131', opacity: 1, thickness: 1.5, fontSize: 14 },
  ink: { color: '#e03131', opacity: 1, thickness: 2, fontSize: 14 },
  arrow: { color: '#e03131', opacity: 1, thickness: 2, fontSize: 14 },
  measure: { color: '#1971c2', opacity: 1, thickness: 1.5, fontSize: 12 },
  text: { color: '#212529', opacity: 1, thickness: 1, fontSize: 14 },
  note: { color: '#f7c948', opacity: 1, thickness: 1, fontSize: 12 },
  stamp: { color: '#e03131', opacity: 0.95, thickness: 1.5, fontSize: 16 },
  image: { color: '#212529', opacity: 1, thickness: 1, fontSize: 14 }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type NewAnnotation = DistributiveOmit<Annotation, 'id' | 'createdAt'>

export function withIdentity(ann: NewAnnotation): Annotation {
  // 展开判别联合后 TS 无法自行收敛回 Annotation;此处仅补 id/createdAt,断言安全
  return { ...ann, id: crypto.randomUUID(), createdAt: Date.now() } as Annotation
}

/** 注释类型中文名 */
export const KIND_LABEL: Record<Annotation['kind'], string> = {
  highlight: '高亮',
  rect: '矩形',
  ellipse: '椭圆',
  ink: '涂鸦',
  arrow: '箭头',
  measure: '测量',
  text: '文字',
  note: '便签',
  image: '图片',
  stamp: '图章'
}

/** 列表摘要 */
export function annotationSummary(ann: Annotation): string {
  if (ann.kind === 'text' || ann.kind === 'note') {
    const text = ann.text.replace(/\s+/g, ' ').trim()
    return text.length > 20 ? `${text.slice(0, 20)}…` : text || '(空)'
  }
  if (ann.kind === 'stamp') return ann.label
  if (ann.kind === 'measure') return '距离测量'
  return KIND_LABEL[ann.kind]
}
