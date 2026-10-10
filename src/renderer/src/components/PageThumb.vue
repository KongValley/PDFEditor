<script setup lang="ts">
import { ref, watch } from 'vue'
import type { RenderTask } from 'pdfjs-dist'
import { docReady, docState, getPage } from '../store/document'
import { getPageViewport, pdfjs } from '../lib/pdfjs'
import { acquireRenderSlot, firstPaintDone, releaseRenderSlot, thumbWatch } from '../store/viewer'

const props = defineProps<{ pageNumber: number; thumbWidth: number; visible: boolean }>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
let task: RenderTask | null = null
let seq = 0

function clearThumb(): void {
  seq++
  task?.cancel()
  task = null
  const canvas = canvasEl.value
  if (canvas) {
    canvas.width = 0
    canvas.height = 0
  }
}

/** 缩略图现在能不能画:打开流程走完 + 几何就绪 + 当前页已画出(见 viewer.ts firstPaintDone) */
const thumbReady = (): boolean => !docState.loading && docReady.value && firstPaintDone.value

async function renderThumb(): Promise<void> {
  if (!props.visible) {
    clearThumb()
    return
  }
  // 让路条件在入口再查一次:下面几个触发源(加载结束/首屏完成)都可能晚于这里的判断
  if (!thumbReady()) return
  const canvas = canvasEl.value
  if (!canvas) return
  const mySeq = ++seq
  // 缩略图走最低优先级槽:整页渲染(尤其当前页)永远排在它前面。
  // 之前缩略图完全不占槽,十几张扫描缩略图能把 pdf.js worker 占满,可见页要等 >16s 才画出来。
  await acquireRenderSlot('thumb')
  try {
    if (mySeq !== seq || !props.visible || !thumbReady()) return
    const page = await getPage(props.pageNumber)
    if (mySeq !== seq) return
    // 缩放比按「旋转后的显示宽度」算:用未旋转的原始宽度会让 /Rotate 90 的页缩略图偏小
    const base = getPageViewport(page, 1, docState.rotationView).viewport
    const scale = props.thumbWidth / Math.max(base.width, 1)
    const { viewport } = getPageViewport(page, scale, docState.rotationView)
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    task?.cancel()
    task = page.render({
      canvasContext: ctx,
      viewport,
      // 批注由主视图的 SVG 覆盖层负责:缩略图若由 pdf.js 画 /Annots,会出现「删除后仍显示旧批注」的不一致
      annotationMode: pdfjs.AnnotationMode.DISABLE
    })
    await task.promise
    thumbWatch.renders++
  } catch (err) {
    if ((err as Error)?.name !== 'RenderingCancelledException') console.warn('缩略图渲染失败:', err)
  } finally {
    releaseRenderSlot()
  }
}

watch(
  // geometryVersion:页面旋转/增删后缩略图内容变了但 pageBoxes 长度不变,没有它不重画
  [
    () => props.visible,
    () => props.thumbWidth,
    () => props.pageNumber,
    () => docState.rotationView,
    () => docState.docId,
    () => docState.geometryVersion,
    // 让路条件本身变化也要重试:打开结束 / 几何就绪 / 首屏画出
    () => docReady.value,
    () => docState.loading,
    firstPaintDone
  ],
  () => {
    void renderThumb()
  },
  { immediate: true }
)
</script>

<template>
  <canvas ref="canvasEl" class="thumb-canvas"></canvas>
</template>

<style scoped>
.thumb-canvas {
  display: block;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
</style>
