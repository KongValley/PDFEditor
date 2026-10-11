/** 文件名/路径的纯字符串助手:主进程与渲染层共用,不判存在、不碰盘 */

/** 末段文件名(分隔符同时接受 / 与 \);空串原样返回 */
export function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** 末段文件名去掉最后一个扩展名(任意扩展名,与 ipc.ts 的历史语义一致);
 * 无扩展名时等于 baseNameOf */
export function stemOf(path: string): string {
  const base = baseNameOf(path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}
