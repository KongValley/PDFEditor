/**
 * ODF 属性读取。
 *
 * ODF 的属性和元素一样带命名空间前缀(text:style-name、fo:font-size、
 * svg:width、xlink:href …),而 xmldom 的 getAttribute 只认「限定名」。
 * 这里按本地名匹配,调用方不用关心前缀是 fo: 还是 style:;同名的前缀属性
 * (如 fo:font-family 与 svg:font-family)出现在不同元素上,不会互相干扰。
 */
import { localNameOf } from '../ofd/model'

export function odfAttr(el: Element, name: string): string | null {
  const direct = el.getAttribute(name)
  if (direct !== null && direct !== '') return direct
  const attributes = el.attributes
  if (!attributes) return null
  for (let i = 0; i < attributes.length; i++) {
    const attribute = attributes.item(i)
    if (!attribute) continue
    if (localNameOf(attribute) === name) {
      const value = attribute.value
      return value === '' ? null : value
    }
  }
  return null
}
