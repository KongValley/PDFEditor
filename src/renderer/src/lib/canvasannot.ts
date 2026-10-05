/**
 * 离屏 canvas 注释画笔:PNG 导出勾选「包含注释」时,把注释按屏幕坐标画到页面位图上。
 * 与 AnnotationShape.vue(SVG 覆盖层)保持同构的几何换算;观感允许 1–2px 级差异。
 * 画布渲染不含批注(pdf.js 只画页面内容),所以这里必须自绘。
 */
import type { PageViewport } from './pdfjs'
import type { Annotation } from '@shared/types'
import { pdfPointToScreen, pdfRectToScreen } from './geo'
import { fitFontSize, pointsToMm, wrapText } from '@shared/text'

/** dataUrl → 已解码图片(未加载完成时先跳过,下次导出即命中) */
const imageCache = new Map<string, HTMLImageElement>()

function getImage(dataUrl: string): HTMLImageElement | null {
  let image = imageCache.get(dataUrl)
  if (!image) {
    image = new Image()
    image.src = dataUrl
    imageCache.set(dataUrl, image)
  }
  return image.complete && image.naturalWidth > 0 ? image : null
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const int = Number.parseInt(value.length === 3 ? value.replace(/./g, (c) => c + c) : value, 16)
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
}

const FONT_FAMILY = 'SimHei, "Microsoft YaHei", sans-serif'

function measureText(text: string, size: number): number {
  const probe = measureTextCtx ?? (measureTextCtx = document.createElement('canvas').getContext('2d'))
  if (!probe) return text.length * size
  probe.font = `${size}px ${FONT_FAMILY}`
  return probe.measureText(text).width
}

let measureTextCtx: CanvasRenderingContext2D | null = null

/** 把某一页的注释画到已渲染的页面位图上 */
export function paintAnnotations(
  ctx: CanvasRenderingContext2D,
  viewport: PageViewport,
  pageIndex: number,
  annotations: Annotation[],
  imageUrls: Record<string, string>
): void {
  const scale = viewport.scale
  for (const ann of annotations) {
    if (ann.page !== pageIndex) continue
    const box = pdfRectToScreen(viewport, ann.bbox)
    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    switch (ann.kind) {
      case 'highlight':
        ctx.globalAlpha = ann.opacity
        ctx.globalCompositeOperation = 'multiply'
        ctx.fillStyle = ann.color
        ctx.fillRect(box.x, box.y, box.w, box.h)
        break
      case 'rect':
        ctx.globalAlpha = ann.opacity
        ctx.strokeStyle = ann.color
        ctx.lineWidth = ann.thickness * scale
        ctx.strokeRect(box.x, box.y, box.w, box.h)
        break
      case 'ellipse':
        ctx.globalAlpha = ann.opacity
        ctx.strokeStyle = ann.color
        ctx.lineWidth = ann.thickness * scale
        ctx.beginPath()
        ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
        break
      case 'ink': {
        ctx.globalAlpha = ann.opacity
        ctx.strokeStyle = ann.color
        ctx.lineWidth = ann.thickness * scale
        ctx.beginPath()
        ann.points.forEach((point, index) => {
          const screen = pdfPointToScreen(viewport, point)
          if (index === 0) ctx.moveTo(screen.x, screen.y)
          else ctx.lineTo(screen.x, screen.y)
        })
        ctx.stroke()
        break
      }
      case 'arrow': {
        const from = pdfPointToScreen(viewport, ann.from)
        const to = pdfPointToScreen(viewport, ann.to)
        ctx.globalAlpha = ann.opacity
        ctx.strokeStyle = ann.color
        ctx.fillStyle = ann.color
        ctx.lineWidth = ann.thickness * scale
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(to.x, to.y)
        ctx.stroke()
        const dx = to.x - from.x
        const dy = to.y - from.y
        const length = Math.hypot(dx, dy) || 1
        const wing = Math.max(6, length * 0.14)
        const angle = Math.atan2(dy, dx)
        const spread = 0.45
        ctx.beginPath()
        ctx.moveTo(to.x, to.y)
        ctx.lineTo(to.x - wing * Math.cos(angle - spread), to.y - wing * Math.sin(angle - spread))
        ctx.lineTo(to.x - wing * Math.cos(angle + spread), to.y - wing * Math.sin(angle + spread))
        ctx.closePath()
        ctx.fill()
        break
      }
      case 'measure': {
        const from = pdfPointToScreen(viewport, ann.from)
        const to = pdfPointToScreen(viewport, ann.to)
        ctx.strokeStyle = ann.color
        ctx.fillStyle = ann.color
        ctx.lineWidth = ann.thickness * scale
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(to.x, to.y)
        ctx.stroke()
        for (const point of [from, to]) {
          ctx.beginPath()
          ctx.arc(point.x, point.y, 3, 0, Math.PI * 2)
          ctx.fill()
        }
        const lengthPt = Math.hypot(ann.to.x - ann.from.x, ann.to.y - ann.from.y)
        ctx.font = `${12 * scale}px ${FONT_FAMILY}`
        ctx.textAlign = 'center'
        ctx.fillText(`${pointsToMm(lengthPt).toFixed(1)} mm`, (from.x + to.x) / 2, (from.y + to.y) / 2 - 6)
        break
      }
      case 'text': {
        ctx.globalAlpha = ann.opacity
        ctx.fillStyle = ann.color
        ctx.font = `${ann.fontSize * scale}px ${FONT_FAMILY}`
        const lines = wrapText(ann.text, Math.max(ann.bbox.w, 8), (s) => measureText(s, ann.fontSize))
        const angle = (((viewport.rotation - ann.rotate) % 360) + 360) % 360
        lines.forEach((line, index) => {
          const baseline = pdfPointToScreen(viewport, {
            x: ann.bbox.x,
            y: ann.bbox.y + ann.bbox.h - ann.fontSize - index * ann.fontSize * 1.2
          })
          ctx.save()
          ctx.translate(baseline.x, baseline.y)
          ctx.rotate((angle * Math.PI) / 180)
          ctx.fillText(line || ' ', 0, 0)
          ctx.restore()
        })
        break
      }
      case 'note': {
        ctx.globalAlpha = ann.opacity
        ctx.fillStyle = ann.color
        ctx.strokeStyle = '#8a6d1a'
        ctx.lineWidth = Math.max(1, scale)
        roundedRect(ctx, box.x, box.y, box.w, box.h, 2)
        ctx.fill()
        ctx.stroke()
        const fold = 8 * Math.min(scale, 1.5)
        ctx.beginPath()
        ctx.moveTo(box.x + box.w - fold, box.y)
        ctx.lineTo(box.x + box.w, box.y + fold)
        ctx.lineTo(box.x + box.w, box.y)
        ctx.closePath()
        ctx.fillStyle = 'rgba(138, 109, 26, 0.5)'
        ctx.fill()
        break
      }
      case 'image': {
        const dataUrl = imageUrls[ann.imgId]
        if (!dataUrl) break
        const image = getImage(dataUrl)
        if (!image) break
        ctx.globalAlpha = ann.opacity
        ctx.drawImage(image, box.x, box.y, box.w, box.h)
        break
      }
      case 'stamp': {
        const fontSize = fitFontSize(ann.label, ann.bbox, (s, size) => measureText(s, size)) * scale
        ctx.fillStyle = hexToRgba(ann.color, 0.08)
        ctx.strokeStyle = ann.color
        ctx.lineWidth = 2 * Math.min(scale, 2)
        roundedRect(ctx, box.x, box.y, box.w, box.h, 4)
        ctx.fill()
        ctx.globalAlpha = ann.opacity
        ctx.stroke()
        ctx.fillStyle = ann.color
        ctx.font = `${fontSize}px ${FONT_FAMILY}`
        ctx.textAlign = 'center'
        const center = pdfPointToScreen(viewport, {
          x: ann.bbox.x + ann.bbox.w / 2,
          y: ann.bbox.y + ann.bbox.h / 2
        })
        ctx.fillText(ann.label, center.x, center.y + fontSize * 0.36)
        break
      }
    }
    ctx.restore()
  }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  const r = Math.min(radius, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}
