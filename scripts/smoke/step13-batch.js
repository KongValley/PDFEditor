// 步骤 13 冒烟:批量拆分 IPC + 拆分/合并对话框端到端 + 重名自动改名
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

window.confirm = () => true

const rotated = `${__smokeRoot}/samples/sample-rotated.pdf`
const stamp = Date.now()

/* ---------- 1. pdf:splitTasks · maxPages + 重名自动改名 ---------- */

const splitOutDir = `${__smokeRoot}/tmp/split-out-${stamp}`
const maxTask = { mode: 'maxPages', path: rotated, start: 1, end: 2, pagesPerFile: 1 }
const maxRes = await window.pdfAPI.invoke('pdf:splitTasks', { tasks: [maxTask], outputDir: splitOutDir })
check('maxPages 成功', maxRes[0].ok === true, maxRes[0])
check('maxPages 输出 2 个文件', maxRes[0].outputs.length === 2, maxRes[0].outputs)
check('首轮首块名', maxRes[0].outputs[0].endsWith('sample-rotated-1.pdf'), maxRes[0].outputs)

await t.openPath(maxRes[0].outputs[0])
await sleep(1200)
check('第 1 块 1 页', t.docState.pageCount === 1, t.docState.pageCount)

await t.openPath(maxRes[0].outputs[1])
await sleep(1200)
check('第 2 块 1 页', t.docState.pageCount === 1, t.docState.pageCount)
const rotatedBox = t.docState.pageBoxes[0]
check('第 2 块为旋转页', Math.round(rotatedBox.w) === 842 && Math.round(rotatedBox.h) === 595, rotatedBox)

// 同目录再跑一轮:全部原名已存在 → 统一 -1 后缀
const againRes = await window.pdfAPI.invoke('pdf:splitTasks', { tasks: [maxTask], outputDir: splitOutDir })
check(
  '重名自动改名 · 首块',
  againRes[0].ok === true && againRes[0].outputs[0].endsWith('sample-rotated-1-1.pdf'),
  againRes[0]
)
check('重名自动改名 · 次块', againRes[0].outputs[1].endsWith('sample-rotated-2-1.pdf'), againRes[0].outputs)
check('两轮路径不同', againRes[0].outputs[0] !== maxRes[0].outputs[0])
await t.openPath(againRes[0].outputs[0])
await sleep(1200)
check('改名产物 1 页', t.docState.pageCount === 1, t.docState.pageCount)

/* ---------- 2. pdf:splitTasks · ranges ---------- */

const rangesTwo = await window.pdfAPI.invoke('pdf:splitTasks', {
  tasks: [{ mode: 'ranges', path: rotated, ranges: [[0], [1]] }],
  outputDir: splitOutDir
})
check('ranges 两段 → 2 文件', rangesTwo[0].ok === true && rangesTwo[0].outputs.length === 2, rangesTwo[0])

const rangesOne = await window.pdfAPI.invoke('pdf:splitTasks', {
  tasks: [{ mode: 'ranges', path: rotated, ranges: [[0, 1]] }],
  outputDir: splitOutDir
})
check('ranges 一段 → 1 文件', rangesOne[0].ok === true && rangesOne[0].outputs.length === 1, rangesOne[0])

await t.openPath(rangesOne[0].outputs[0])
await sleep(1200)
check('ranges 产物 2 页', t.docState.pageCount === 2, t.docState.pageCount)

/* ---------- 3. docId 内存态分支 ---------- */

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
check('初始 3 页', t.docState.pageCount === 3, t.docState.pageCount)
await t.deletePages([0])
await sleep(700)
check('删除后 2 页', t.docState.pageCount === 2, t.docState.pageCount)

const memRes = await window.pdfAPI.invoke('pdf:splitTasks', {
  tasks: [
    {
      mode: 'maxPages',
      docId: t.docState.docId,
      path: t.docState.filePath,
      start: 1,
      end: 2,
      pagesPerFile: 2
    }
  ],
  outputDir: `${__smokeRoot}/tmp/split-out2`
})
check('内存态拆分成功', memRes[0].ok === true, memRes[0])

await t.openPath(memRes[0].outputs[0])
await sleep(1200)
check('内存态产物 2 页(非磁盘 3 页)', t.docState.pageCount === 2, t.docState.pageCount)

/* ---------- 4. 合并对话框 E2E + 重名自动改名 ---------- */

const mergeDir = `${__smokeRoot}/tmp`
const mergeName = `smoke-merge-${stamp}`

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
check('合并前 3 页', t.docState.pageCount === 3, t.docState.pageCount)

const first = t.mergePdfs()
await sleep(400)
check('合并对话框打开', !!document.querySelector('.dialog'))
t.mergeDialogState.rows.push({
  kind: 'file',
  path: rotated,
  name: 'sample-rotated.pdf',
  pageCount: 2,
  start: '1',
  end: '1',
  selected: false
})
t.mergeDialogState.outputName = mergeName
t.mergeDialogState.outputDir = mergeDir
await sleep(100)
const mergePrimary = document.querySelector('.dialog button.primary')
check('开始合并可用', !!mergePrimary && mergePrimary.disabled === false)
mergePrimary.click()
await first
await sleep(1200)
check('合并后 4 页', t.docState.pageCount === 4, t.docState.pageCount)
check('切到合并结果', (t.docState.filePath ?? '').endsWith(`${mergeName}.pdf`), t.docState.filePath)

await t.openPath(`${mergeDir}/${mergeName}.pdf`)
await sleep(1300)
check('合并产物 4 页', t.docState.pageCount === 4, t.docState.pageCount)

// 同名再合并一次 → -1 后缀
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
const second = t.mergePdfs()
await sleep(400)
t.mergeDialogState.rows.push({
  kind: 'file',
  path: rotated,
  name: 'sample-rotated.pdf',
  pageCount: 2,
  start: '1',
  end: '1',
  selected: false
})
t.mergeDialogState.outputName = mergeName
t.mergeDialogState.outputDir = mergeDir
await sleep(100)
const mergePrimary2 = document.querySelector('.dialog button.primary')
check('第二次开始合并可用', !!mergePrimary2 && mergePrimary2.disabled === false)
mergePrimary2.click()
await second
await sleep(1200)
check('重名自动改名 · 合并', (t.docState.filePath ?? '').endsWith(`${mergeName}-1.pdf`), t.docState.filePath)
await t.openPath(`${mergeDir}/${mergeName}-1.pdf`)
await sleep(1300)
check('改名合并产物 4 页', t.docState.pageCount === 4, t.docState.pageCount)

/* ---------- 5. 输出目录不存在 → 自动创建 ---------- */

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
const newDir = `${__smokeRoot}/tmp/merge-newdir-${stamp}`
const third = t.mergePdfs()
await sleep(400)
t.mergeDialogState.rows.push({
  kind: 'file',
  path: rotated,
  name: 'sample-rotated.pdf',
  pageCount: 2,
  start: '1',
  end: '1',
  selected: false
})
t.mergeDialogState.outputName = `smoke-newdir-${stamp}`
t.mergeDialogState.outputDir = newDir
await sleep(100)
const mergePrimary3 = document.querySelector('.dialog button.primary')
check('新建目录:开始合并可用', !!mergePrimary3 && mergePrimary3.disabled === false)
mergePrimary3.click()
await third
await sleep(1200)
check(
  '新建目录:合并成功',
  (t.docState.filePath ?? '').endsWith(`smoke-newdir-${stamp}.pdf`),
  t.docState.filePath
)
await t.openPath(`${newDir}/smoke-newdir-${stamp}.pdf`)
await sleep(1300)
check('新建目录:产物可重开 4 页', t.docState.pageCount === 4, t.docState.pageCount)

// 导出到不存在的目录(docops export 分支 mkdir)
const exportDir = `${__smokeRoot}/tmp/export-newdir-${stamp}`
await t.exportPages([0], `${exportDir}/x.pdf`)
await sleep(400)
await t.openPath(`${exportDir}/x.pdf`)
await sleep(1200)
check('导出新建目录产物 1 页', t.docState.pageCount === 1, t.docState.pageCount)

/* ---------- 6. 拆分对话框 E2E + uniquePath 探针 ---------- */

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
const splitGuiDir = `${__smokeRoot}/tmp/split-gui-${stamp}`
const splitPending = t.splitPdfs()
await sleep(400)
check('拆分对话框打开', !!document.querySelector('.dialog'))

t.splitDialogState.rows.push({
  kind: 'file',
  path: rotated,
  name: 'sample-rotated.pdf',
  pageCount: 2,
  mode: 'maxPages',
  start: '1',
  end: '2',
  pagesPerFile: '1',
  ranges: '1-2',
  selected: false
})
t.splitDialogState.outputDir = splitGuiDir
await sleep(100)
const splitPrimary = document.querySelector('.dialog button.primary')
check('开始拆分可用', !!splitPrimary && splitPrimary.disabled === false)
splitPrimary.click()
await splitPending
await sleep(1200)

await t.openPath(`${splitGuiDir}/sample-rotated-1.pdf`)
await sleep(1200)
check('拆分产物 1 页', t.docState.pageCount === 1, t.docState.pageCount)

const probe = await window.pdfAPI.invoke('app:uniquePath', { dir: splitGuiDir, name: 'sample-rotated-1.pdf' })
check('uniquePath 探针 -1 后缀', probe.path.endsWith('sample-rotated-1-1.pdf'), probe.path)

/* ---------- 7. 拆分失败提示带文件名 ---------- */

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
const failPending = t.splitPdfs()
await sleep(400)
t.splitDialogState.rows.push({
  kind: 'file',
  path: `${__smokeRoot}/tmp/nodir-${stamp}/no-such.pdf`,
  name: 'no-such.pdf',
  pageCount: 1,
  mode: 'maxPages',
  start: '1',
  end: '1',
  pagesPerFile: '1',
  ranges: '1',
  selected: false
})
t.splitDialogState.outputDir = `${__smokeRoot}/tmp/split-fail-${stamp}`
await sleep(100)
const failPrimary = document.querySelector('.dialog button.primary')
check('失败场景开始拆分可用', !!failPrimary && failPrimary.disabled === false)
failPrimary.click()
await failPending
await sleep(600)
check(
  '失败提示带文件名',
  t.ui.toast?.kind === 'error' && (t.ui.toast?.text ?? '').includes('no-such.pdf'),
  t.ui.toast
)

/* ---------- 8. openFolder 失败返回(目录不存在时不触碰系统 Shell,无弹框) ---------- */

const openFail = await window.pdfAPI.invoke('app:openFolder', `${__smokeRoot}/tmp/no-such-dir-${stamp}/x.pdf`)
check('openFolder 失败返回 ok:false', openFail.ok === false, openFail)

/* ---------- 9. 取消不生效 ---------- */

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
const cancelPending = t.mergePdfs()
await sleep(400)
const cancelButton = document.querySelector('.dialog .actions button')
check('对话框存在可取消', !!cancelButton)
cancelButton.click()
await cancelPending
await sleep(200)
check('取消后对话框关闭', !document.querySelector('.dialog'))
check('取消后页数不变', t.docState.pageCount === 3, t.docState.pageCount)

return {
  maxPages: 'ok',
  dedup: 'ok',
  ranges: 'ok',
  docIdBranch: 'ok',
  mergeDialog: 'ok',
  mergeDedup: 'ok',
  newDir: 'ok',
  splitDialog: 'ok',
  uniqueProbe: 'ok',
  failToast: 'ok',
  openFolderFail: 'ok',
  cancel: 'ok'
}
