import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { FormFieldInfo, FormFieldType, FormValue } from '@shared/types'
import { getDocEntry } from './pdfio'

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
  if (objectType === 'text' || objectType === 'checkbox' || objectType === 'radiobutton') {
    if (objectType === 'text') return 'text'
    if (objectType === 'checkbox') return 'checkbox'
    return 'radio'
  }
  if (objectType === 'combobox' || objectType === 'listbox') return 'choice'
  switch (widget.fieldType) {
    case 'Tx':
      return 'text'
    case 'Btn':
      if (widget.radioButton) return 'radio'
      return 'checkbox'
    case 'Ch':
      return 'choice'
    default:
      return 'unknown'
  }
}

function normalizeValue(type: FormFieldType, raw: unknown): FormValue | undefined {
  if (raw === undefined || raw === null) return undefined
  if (type === 'checkbox' || type === 'radio') {
    if (typeof raw === 'boolean') return raw
    return typeof raw === 'string' && raw !== 'Off' && raw !== ''
  }
  if (Array.isArray(raw)) return raw.map((v) => String(v)).join(', ')
  return String(raw)
}

/**
 * 解析 AcroForm 字段(main 侧,使用 pdf.js legacy 构建)。
 * 字段全名通过 getFieldObjects() 的 id → name 映射还原。
 */
export async function getFormFields(docId: string): Promise<FormFieldInfo[]> {
  const entry = getDocEntry(docId)
  if (!entry || entry.encrypted) return []

  const doc = await getDocument({ data: new Uint8Array(entry.buffer) }).promise
  try {
    const fieldObjects = await doc.getFieldObjects()
    const fullNameById = new Map<string, string>()
    const objectTypeById = new Map<string, string>()
    if (fieldObjects) {
      for (const [name, list] of fieldObjects) {
        for (const object of list) {
          const record = object as { id?: unknown; type?: unknown }
          if (typeof record.id !== 'string') continue
          fullNameById.set(record.id, name)
          if (typeof record.type === 'string') objectTypeById.set(record.id, record.type)
        }
      }
    }

    const fields: FormFieldInfo[] = []
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
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
  } finally {
    await doc.cleanup()
  }
}
