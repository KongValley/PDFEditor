// 步骤 11 冒烟(低内存):反复打开不同文档,验证旧 PDFDocumentProxy 被 cleanup、pin 集合被清空
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

for (const f of ['sample-outline.pdf', 'sample-zh.pdf', 'sample-outline.pdf']) {
  await t.openPath(`${__smokeRoot}/samples/${f}`)
  await sleep(400)
}
await sleep(800)

// openByPath 每个成功入口都必须把上一份文档 cleanup 掉(否则 worker 侧资源累积)
check('旧文档已释放', t.cleanupCount() >= 2, t.cleanupCount())
// 换文档时必须立即释放上一份在主进程的整份字节(否则最多驻留 MAX_DOCS=3 份大文件)
check('上一份文档的 docId 已释放', t.releasedDocIds.length >= 2, t.releasedDocIds)
check('释放的不是当前文档', !t.releasedDocIds.includes(t.docState.docId), {
  released: t.releasedDocIds,
  current: t.docState.docId
})
// 换文档后残留的可见/pin 页号必须清空(否则新文档同号页被豁免回收)
// pin 集合必须跟随当前文档重建(旧文档页号不会跨文档残留):
// 打开第 3 个文档(与第 1 个同名样本)后 pin 只反映当前可见页,不会出现第 2 个文档的痕迹
check('pin 集合已重置', t.pinnedPageCounts().viewer <= 2 && t.pinnedPageCounts().thumbs <= 12, t.pinnedPageCounts())
check('pageCache 重置', t.cachedPageCount() <= 12, t.cachedPageCount())

return {
  cleanups: t.lastCleanupCount,
  pinned: t.pinnedPageCounts(),
  heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)
}
