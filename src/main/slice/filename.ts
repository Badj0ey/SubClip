/**
 * 切片备注名 → 安全文件名。
 *
 * 单独放一个零依赖模块，方便直接单测（`engine.ts` 会连带 electron 一起被打包进来）。
 */

/** Windows 保留设备名：拿这些名字当文件名会失败，或指向设备而不是文件 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 文件名最大长度（给 `.mp4` 等后缀和目录留着余量） */
const MAX_LENGTH = 96

const stripTail = (s: string): string => s.replace(/[. ]+$/g, '')

/**
 * 把任意文本净化成安全的文件名。
 *
 * 除了替换非法字符，还要处理 Windows 的两个坑：
 *   - 结尾的点和空格会被系统悄悄去掉，导致「上报给界面的文件名」和实际生成的不一致；
 *   - `CON` / `NUL` / `COM1` 这类设备名直接当文件名会失败。
 */
export function sanitizeFileName(name: string): string {
  let out = stripTail(
    String(name ?? '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
  ).slice(0, MAX_LENGTH)

  // 截断后可能又落回点/空格结尾，再清一次
  out = stripTail(out)
  if (!out) out = 'clip'
  if (RESERVED_NAME.test(out)) out = `_${out}`
  return out
}
