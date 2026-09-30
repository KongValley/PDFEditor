// 步骤 1 冒烟:应用外壳是否渲染
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
return {
  title: document.title,
  hasToolbar: !!document.querySelector('.toolbar'),
  hasViewer: !!document.querySelector('.viewer-area'),
  text: (document.body.innerText || '').slice(0, 200)
}
