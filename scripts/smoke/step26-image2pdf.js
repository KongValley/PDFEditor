// 步骤 26 冒烟:图片转 PDF —— 对话框状态、进度事件、页尺寸规则、自动打开与失败处理
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

const icon = `${__smokeRoot}/resources/icon.png` // 512×512 PNG,仓库内自带
const iconItem = { path: icon, name: 'icon.png', width: 512, height: 512 }

/* ---------- 1. 对话框 ---------- */
await t.openImageToPdfDialog()
check('对话框已打开', t.imagePdfDialogState.open === true, t.imagePdfDialogState.open)
check('未在运行', t.imagePdfDialogState.running === false, t.imagePdfDialogState.running)
check('默认页尺寸为按图像尺寸', t.imagePdfDialogState.pageMode === 'image', t.imagePdfDialogState.pageMode)
check('初始无文件', t.imagePdfDialogState.items.length === 0, t.imagePdfDialogState.items.length)
check('工具栏有图片转 PDF 按钮', !!document.querySelector('.toolbar button[title*="图片"]'))
check('空状态有图片转 PDF 按钮', !!document.querySelector('.empty-area button[title*="图片"]'))

/* ---------- 2. 转换(默认页尺寸)+ 进度事件 ---------- */
const events = []
const off = window.pdfAPI.on('img:toPdfProgress', (info) => {
  if (info?.jobId?.startsWith('img2pdf-')) events.push(info)
})
await t.openImageToPdfDialog([icon, icon])
check('拖入预填得到 2 个文件', t.imagePdfDialogState.items.length === 2, t.imagePdfDialogState.items)
check('文件信息已读取', t.imagePdfDialogState.items[0]?.width === 512, t.imagePdfDialogState.items[0])
await t.convertImagesToPdf(t.imagePdfDialogState.items)
await sleep(1500)
off()
const state = t.imagePdfDialogState
check('收到进度事件', events.length >= 2, events.length)
check('进度事件带总数', events[0]?.total === 2, events[0])
check('进度走完', state.done === 2, state.done)
check('转换中状态已复位', state.running === false, state.running)
check('结果为成功', state.result?.ok === true, state.result)
check('结果页数为 2', state.result?.pages === 2, state.result?.pages)

/* ---------- 3. 页尺寸规则 + 自动打开 ---------- */
check('结果已自动打开', t.docState.pageCount === 2, t.docState.pageCount)
// 512px @96 DPI → 512 * 72/96 = 384pt,方形页
check('按图像尺寸:页为 384×384', Math.abs(t.docState.pageBoxes[0].w - 384) < 1 && Math.abs(t.docState.pageBoxes[0].h - 384) < 1, t.docState.pageBoxes[0])

/* ---------- 4. A4 模式(方形图 → 纵向 A4) ---------- */
await t.openImageToPdfDialog([icon])
t.imagePdfDialogState.pageMode = 'a4'
await t.convertImagesToPdf(t.imagePdfDialogState.items)
await sleep(1500)
check('A4 模式转换成功', t.imagePdfDialogState.result?.ok === true, t.imagePdfDialogState.result)
check('A4 模式为 1 页', t.imagePdfDialogState.result?.pages === 1, t.imagePdfDialogState.result?.pages)
check(
  'A4 页尺寸 595.28×841.89',
  Math.abs(t.docState.pageBoxes[0].w - 595.28) < 1 && Math.abs(t.docState.pageBoxes[0].h - 841.89) < 1,
  t.docState.pageBoxes[0]
)

/* ---------- 5. 不支持的格式 ---------- */
// a) 添加时就被拦下:openImageToPdfDialog 读取文件头失败 → 列表为空 + toast 说明
await t.openImageToPdfDialog([`${__smokeRoot}/package.json`])
await sleep(300)
check('非图片添加时被拦下', t.imagePdfDialogState.items.length === 0, t.imagePdfDialogState.items)
check('提示仅支持 PNG/JPEG', (t.ui.toast?.text ?? '').includes('PNG'), t.ui.toast?.text)

// b) 绕过添加直接转换(列表被外部改坏):主进程逐张判定 → 全部失败 → 结果为失败
t.imagePdfDialogState.items = [
  { path: `${__smokeRoot}/package.json`, name: 'package.json', width: 1, height: 1 }
]
await t.convertImagesToPdf(t.imagePdfDialogState.items)
await sleep(1200)
check('非图片转换被拒绝', t.imagePdfDialogState.result?.ok === false, t.imagePdfDialogState.result)
check(
  '给出仅支持 PNG/JPEG 的原因',
  (t.imagePdfDialogState.result?.error ?? '').includes('PNG'),
  t.imagePdfDialogState.result?.error
)

return {
  dialog: 'ok',
  progress: events.length,
  // 必须展开成普通对象:reactive 代理无法结构化克隆
  imageSize: { ...t.docState.pageBoxes[0] },
  a4: 'ok',
  rejectUnsupported: 'ok'
}