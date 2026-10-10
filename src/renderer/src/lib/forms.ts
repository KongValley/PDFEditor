import type { FormFieldInfo, FormFieldType, FormValue } from '@shared/types'
import type { PDFDocumentProxy } from './pdfjs'

interface WidgetLike {
  subtype?: string
  id?: string
  fieldName?: string
  fieldType?: string
  fieldValue?: unknown
  checkBox?: boolean
  radioButton?: boolean
  comboBox?: boolean
  listBox?: boolean
  buttonValue?: string
  options?: Array<{ displayValue?: string; exportValue?: string }>
  rect?: number[]
}

function mapFieldType(widget: WidgetLike, objectType?: string): FormFieldType {
  if (objectType === 'text') return 'text'
  if (objectType === 'checkbox') return 'checkbox'
  if (objectType === 'radiobutton') return 'radio'
  if (objectType === 'combobox' || objectType === 'listbox') return 'choice'
  switch (widget.fieldType) {
    case 'Tx':
      return 'text'
    case 'Btn':
      return widget.radioButton ? 'radio' : 'checkbox'
    case 'Ch':
      return 'choice'
    default:
      return 'unknown'
  }
}

function normalizeValue(type: FormFieldType, raw: unknown): FormValue | undefined {
  if (raw === undefined || raw === null) return undefined
  // 单选组的值必须是选中按钮的导出值(字符串);布尔值无法写回,不作为初始值
  if (type === 'radio') {
    return typeof raw === 'string' && raw !== 'Off' && raw !== '' ? raw : undefined
  }
  if (type === 'checkbox') {
    if (typeof raw === 'boolean') return raw
    return typeof raw === 'string' && raw !== 'Off' && raw !== ''
  }
  if (Array.isArray(raw)) return raw.map((v) => String(v)).join(', ')
  return String(raw)
}

/**
 * 解析 AcroForm 字段(渲染进程侧,复用已加载的 pdf.js 文档,避免主进程二次解析整份 PDF)。
 * 字段全名通过 getFieldObjects() 的 id → name 映射还原。
 */
export async function discoverFormFields(
  doc: PDFDocumentProxy,
  /** 页子集(1-based;缺省 = 全部页)——增量重建时只扫受影响页 */
  pageNumbers?: number[]
): Promise<FormFieldInfo[]> {
  const targetPages = pageNumbers ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)
  const fieldObjects = await doc.getFieldObjects()
  // 没有 AcroForm ⇒ 逐页 getAnnotations 找 Widget 也产不出可填控件(Widget 必须挂在字段上)
  if (fieldObjects === null) return []
  const fullNameById = new Map<string, string>()
  const objectTypeById = new Map<string, string>()
  if (fieldObjects) {
    // pdf.js v3 返回纯对象 {字段名: 字段对象[]}(v6 返回 Map),统一走 entries
    for (const [name, list] of Object.entries(fieldObjects)) {
      for (const object of list as Array<{ id?: unknown; type?: unknown }>) {
        if (typeof object.id !== 'string') continue
        fullNameById.set(object.id, name)
        if (typeof object.type === 'string') objectTypeById.set(object.id, object.type)
      }
    }
  }

  const fields: FormFieldInfo[] = []
  for (const pageNumber of targetPages) {
    const page = await doc.getPage(pageNumber)
    const annotations = (await page.getAnnotations({ intent: 'display' })) as unknown as WidgetLike[]
    for (const widget of annotations) {
      if (widget.subtype !== 'Widget') continue
      const rect = widget.rect
      if (!Array.isArray(rect) || rect.length < 4) continue
      const id = typeof widget.id === 'string' ? widget.id : ''
      const fullName = fullNameById.get(id) ?? ''
      const partialName = typeof widget.fieldName === 'string' ? widget.fieldName : ''
      const type = mapFieldType(widget, objectTypeById.get(id))
      if (type === 'unknown') continue
      fields.push({
        name: partialName || fullName || id,
        fullName: fullName || partialName || id,
        type,
        page: pageNumber - 1,
        rect: { x: rect[0], y: rect[1], w: rect[2] - rect[0], h: rect[3] - rect[1] },
        options:
          widget.radioButton && typeof widget.buttonValue === 'string'
            ? [widget.buttonValue]
            : widget.options?.map((o) => String(o.exportValue ?? o.displayValue ?? '')),
        value: normalizeValue(type, widget.fieldValue),
        hierarchical: fullName === ''
      })
    }
  }
  return fields
}
