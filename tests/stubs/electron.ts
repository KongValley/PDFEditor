/**
 * 单测用的 electron 存根(vitest.config.ts 里把 'electron' 别名指向本文件)。
 * recent.ts 用 app.getPath('userData') 定位 recent.json;print.ts 以值方式 import BrowserWindow。
 */
export const app = {
  getPath: (name: string): string => (name === 'userData' ? (process.env['VITEST_USER_DATA'] ?? '') : '')
}

export class BrowserWindow {}