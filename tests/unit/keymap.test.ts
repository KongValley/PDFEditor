import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * isTypingTarget 是纯字符串/标签判定,但 keymap.ts 顶层 import 链(actions → store →
 * lib/pdfjs)会在模块加载时就读 window.location.href 构造资源基址,必须先打桩。
 */
vi.stubGlobal('window', {
  addEventListener: () => {},
  removeEventListener: () => {},
  confirm: () => true,
  location: { href: 'app://./index.html' }
})

const { isTypingTarget } = await import('../../src/renderer/src/lib/keymap')

/** DOM 节点替身:isTypingTarget 只读 tagName/isContentEditable,不需要真 DOM */
function fakeTarget(tagName?: string, isContentEditable = false): EventTarget | null {
  if (!tagName) return null
  return { tagName, isContentEditable } as unknown as HTMLElement
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isTypingTarget:输入框守卫', () => {
  it('input/textarea/select 让位原生行为', () => {
    expect(isTypingTarget(fakeTarget('INPUT'))).toBe(true)
    expect(isTypingTarget(fakeTarget('TEXTAREA'))).toBe(true)
    expect(isTypingTarget(fakeTarget('SELECT'))).toBe(true)
  })

  it('contenteditable 容器也让位', () => {
    expect(isTypingTarget(fakeTarget('DIV', true))).toBe(true)
  })

  it('普通元素/null 不拦', () => {
    expect(isTypingTarget(fakeTarget('DIV'))).toBe(false)
    expect(isTypingTarget(fakeTarget('BODY'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
