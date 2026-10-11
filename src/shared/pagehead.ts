/** 页码/水印的纯计算:渲染层(对话框预览)与主进程(实际写入)共用,保证所见即所得 */

export type PageNumberFormat = '1' | '第 1 页' | '第 1 页 / 共 N 页' | '1 / N'

/** 模板里的固定文字是否含非 ASCII —— 决定这次要不要嵌中文字体(缺字体时纯 ASCII 仍可用 Helvetica) */
export function pageNumberNeedsCjk(format: PageNumberFormat): boolean {
  return /[^\x00-\x7F]/.test(format)
}

export function formatPageNumber(format: PageNumberFormat, page: number, total: number): string {
  switch (format) {
    case '1':
      return String(page)
    case '第 1 页':
      return `第 ${page} 页`
    case '第 1 页 / 共 N 页':
      return `第 ${page} 页 / 共 ${total} 页`
    case '1 / N':
      return `${page} / ${total}`
  }
}

/** 水印落点:居中单条,或按文本包围盒 + 40pt 间距铺满页面(网格以页中心对称) */
export function watermarkPlacements(
  page: { width: number; height: number },
  text: { width: number; height: number },
  tile: boolean
): Array<{ x: number; y: number }> {
  if (!tile) return [{ x: page.width / 2, y: page.height / 2 }]
  const gapX = text.width + 40
  const gapY = text.height + 40
  const cols = Math.max(1, Math.ceil(page.width / gapX))
  const rows = Math.max(1, Math.ceil(page.height / gapY))
  const stepX = page.width / cols
  const stepY = page.height / rows
  const out: Array<{ x: number; y: number }> = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ x: stepX * (c + 0.5), y: stepY * (r + 0.5) })
    }
  }
  return out
}
