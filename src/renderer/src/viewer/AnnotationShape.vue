<script setup lang="ts">
import { computed } from 'vue'
import type { PageViewport } from 'pdfjs-dist'
import type { Annotation } from '@shared/types'
import { pdfPointToScreen, pdfRectToScreen } from '../lib/geo'
import { annotState } from '../store/annotations'
import { fitFontSize, pointsToMm, wrapText } from '@shared/text'

const props = defineProps<{ ann: Annotation; viewport: PageViewport }>()

const vp = computed(() => props.viewport)
const scale = computed(() => props.viewport.scale)
const box = computed(() => pdfRectToScreen(vp.value, props.ann.bbox))

let measureCtx: CanvasRenderingContext2D | null = null
/** 上次写入的字体串:wrapText 逐字符 measure 时不必重复重设字体状态 */
let lastFont = ''
function measureText(text: string, size: number): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * size
  const font = `${size}px SimHei, "Microsoft YaHei", sans-serif`
  if (font !== lastFont) {
    measureCtx.font = font
    lastFont = font
  }
  return measureCtx.measureText(text).width
}

/** 文本注释:逐行基线(屏幕坐标)与旋转角 */
const textLines = computed(() => {
  const ann = props.ann
  if (ann.kind !== 'text') return []
  const lines = wrapText(ann.text, Math.max(ann.bbox.w, 8), (s) => measureText(s, ann.fontSize))
  const screenAngle = ((vp.value.rotation - ann.rotate) % 360 + 360) % 360
  return lines.map((line, index) => {
    const baselinePdf = {
      x: ann.bbox.x,
      y: ann.bbox.y + ann.bbox.h - ann.fontSize - index * ann.fontSize * 1.2
    }
    const point = pdfPointToScreen(vp.value, baselinePdf)
    return { line, x: point.x, y: point.y, angle: screenAngle }
  })
})

const inkPoints = computed(() => {
  const ann = props.ann
  if (ann.kind !== 'ink') return ''
  return ann.points
    .map((p) => {
      const point = pdfPointToScreen(vp.value, p)
      return `${point.x.toFixed(1)},${point.y.toFixed(1)}`
    })
    .join(' ')
})

const arrowGeom = computed(() => {
  const ann = props.ann
  if (ann.kind !== 'arrow') return null
  const from = pdfPointToScreen(vp.value, ann.from)
  const to = pdfPointToScreen(vp.value, ann.to)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const wing = Math.max(6, length * 0.14)
  const angle = Math.atan2(dy, dx)
  const spread = 0.45
  const p1 = { x: to.x - wing * Math.cos(angle - spread), y: to.y - wing * Math.sin(angle - spread) }
  const p2 = { x: to.x - wing * Math.cos(angle + spread), y: to.y - wing * Math.sin(angle + spread) }
  return { from, to, head: `${to.x},${to.y} ${p1.x},${p1.y} ${p2.x},${p2.y}` }
})

const measureGeom = computed(() => {
  const ann = props.ann
  if (ann.kind !== 'measure') return null
  const from = pdfPointToScreen(vp.value, ann.from)
  const to = pdfPointToScreen(vp.value, ann.to)
  const lengthPt = Math.hypot(ann.to.x - ann.from.x, ann.to.y - ann.from.y)
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  return { from, to, mid, label: `${pointsToMm(lengthPt).toFixed(1)} mm` }
})

const stampGeom = computed(() => {
  const ann = props.ann
  if (ann.kind !== 'stamp') return null
  const fontSize = fitFontSize(ann.label, ann.bbox, (s, size) => measureText(s, size))
  const center = pdfPointToScreen(vp.value, {
    x: ann.bbox.x + ann.bbox.w / 2,
    y: ann.bbox.y + ann.bbox.h / 2
  })
  return { fontSize: fontSize * scale.value, center }
})

const imageHref = computed(() => (props.ann.kind === 'image' ? annotState.imageUrls[props.ann.imgId] ?? '' : ''))
</script>

<template>
  <g class="shape">
    <template v-if="ann.kind === 'highlight'">
      <rect :x="box.x" :y="box.y" :width="box.w" :height="box.h" :fill="ann.color" :fill-opacity="ann.opacity" />
    </template>

    <template v-else-if="ann.kind === 'rect'">
      <rect
        :x="box.x"
        :y="box.y"
        :width="box.w"
        :height="box.h"
        fill="none"
        :stroke="ann.color"
        :stroke-width="ann.thickness * scale"
        :stroke-opacity="ann.opacity"
      />
    </template>

    <template v-else-if="ann.kind === 'ellipse'">
      <ellipse
        :cx="box.x + box.w / 2"
        :cy="box.y + box.h / 2"
        :rx="box.w / 2"
        :ry="box.h / 2"
        fill="none"
        :stroke="ann.color"
        :stroke-width="ann.thickness * scale"
        :stroke-opacity="ann.opacity"
      />
    </template>

    <template v-else-if="ann.kind === 'ink'">
      <polyline
        :points="inkPoints"
        fill="none"
        :stroke="ann.color"
        :stroke-width="ann.thickness * scale"
        :stroke-opacity="ann.opacity"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <template v-else-if="ann.kind === 'arrow' && arrowGeom">
      <line
        :x1="arrowGeom.from.x"
        :y1="arrowGeom.from.y"
        :x2="arrowGeom.to.x"
        :y2="arrowGeom.to.y"
        :stroke="ann.color"
        :stroke-width="ann.thickness * scale"
        :stroke-opacity="ann.opacity"
        stroke-linecap="round"
      />
      <polygon :points="arrowGeom.head" :fill="ann.color" :fill-opacity="ann.opacity" />
    </template>

    <template v-else-if="ann.kind === 'measure' && measureGeom">
      <line
        :x1="measureGeom.from.x"
        :y1="measureGeom.from.y"
        :x2="measureGeom.to.x"
        :y2="measureGeom.to.y"
        :stroke="ann.color"
        :stroke-width="ann.thickness * scale"
      />
      <circle :cx="measureGeom.from.x" :cy="measureGeom.from.y" :r="3" :fill="ann.color" />
      <circle :cx="measureGeom.to.x" :cy="measureGeom.to.y" :r="3" :fill="ann.color" />
      <text
        :x="measureGeom.mid.x"
        :y="measureGeom.mid.y - 6"
        :font-size="12 * scale"
        :fill="ann.color"
        text-anchor="middle"
        class="measure-label"
      >
        {{ measureGeom.label }}
      </text>
    </template>

    <template v-else-if="ann.kind === 'text'">
      <text
        v-for="(line, index) in textLines"
        :key="index"
        :x="line.x"
        :y="line.y"
        :font-size="ann.fontSize * scale"
        :fill="ann.color"
        :fill-opacity="ann.opacity"
        :transform="`rotate(${line.angle}, ${line.x}, ${line.y})`"
        class="text-ann"
      >
        {{ line.line || ' ' }}
      </text>
    </template>

    <template v-else-if="ann.kind === 'note'">
      <rect
        :x="box.x"
        :y="box.y"
        :width="box.w"
        :height="box.h"
        rx="2"
        :fill="ann.color"
        :fill-opacity="ann.opacity"
        stroke="#8a6d1a"
        :stroke-opacity="ann.opacity"
        :stroke-width="Math.max(1, scale)"
      />
      <path
        :d="`M ${box.x + box.w - 8 * Math.min(scale, 1.5)} ${box.y} L ${box.x + box.w} ${box.y + 8 * Math.min(scale, 1.5)} L ${box.x + box.w} ${box.y} Z`"
        fill="#8a6d1a"
        fill-opacity="0.5"
      />
    </template>

    <template v-else-if="ann.kind === 'image' && imageHref">
      <image
        :href="imageHref"
        :x="box.x"
        :y="box.y"
        :width="box.w"
        :height="box.h"
        preserveAspectRatio="none"
        :opacity="ann.opacity"
      />
    </template>

    <template v-else-if="ann.kind === 'stamp' && stampGeom">
      <rect
        :x="box.x"
        :y="box.y"
        :width="box.w"
        :height="box.h"
        rx="4"
        :fill="ann.color"
        fill-opacity="0.08"
        :stroke="ann.color"
        :stroke-width="2 * Math.min(scale, 2)"
        :stroke-opacity="ann.opacity"
      />
      <text
        :x="stampGeom.center.x"
        :y="stampGeom.center.y + stampGeom.fontSize * 0.36"
        :font-size="stampGeom.fontSize"
        :fill="ann.color"
        text-anchor="middle"
        class="stamp-label"
      >
        {{ ann.label }}
      </text>
    </template>
  </g>
</template>

<style scoped>
.text-ann,
.stamp-label {
  font-family: SimHei, 'Microsoft YaHei', sans-serif;
  user-select: none;
}

.measure-label {
  font-family: SimHei, 'Microsoft YaHei', sans-serif;
  user-select: none;
}
</style>
