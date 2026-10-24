/**
 * 文本 → 安全文件名（第五阶段）。
 *
 * 与切片引擎共用同一份实现：命名逻辑要能在**渲染进程**（时间轴生成默认名字）
 * 与主进程（真正写文件）两边都用，所以放在 `shared`。
 * `src/main/slice/filename.ts` 只是它的转发，避免历史导入路径失效。
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
