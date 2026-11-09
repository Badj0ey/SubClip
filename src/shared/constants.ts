/**
 * 跨进程共享的常量（不依赖 Electron，便于单元测试）。
 *
 * 注意：这里**不再**内置需求文档里那两个开发机绝对路径
 * （`D:\subtitle2clip\...`、`D:\bili_subtitle_extension_native...`）。
 * 它们在别人的机器上必然不存在，会让新装用户一进设置页就看到「目录不存在」，
 * 看起来像装坏了。这类目录一律默认留空、由用户按需选择。
 */

/** 默认的浏览器用户脚本通信端口 */
export const DEFAULT_PORT = 8765

/**
 * 业务数据目录名（位于 userData 下）。
 * 刻意避开 `cache` / `Cache`，否则会被 Chromium 的磁盘缓存接管并清空。
 */
export const APP_DATA_DIR = 'subclip-data'

/** 本地切片画质选项（B站 qn 值） */
export const QUALITY_OPTIONS = [
  { value: 120, label: '4K 超清' },
  { value: 116, label: '1080P 60帧' },
  { value: 80, label: '1080P 高清' },
  { value: 64, label: '720P 高清' },
  { value: 32, label: '480P 清晰' },
  { value: 16, label: '360P 流畅' }
]

/**
 * 画质代码（B站 qn 值）转中文标签。
 *
 * `QUALITY_OPTIONS` 只有设置里能选的那六档；B 站实际下发时还会出现
 * 74（720P 60帧）、112（1080P+）、125（HDR）、126（杜比视界）、127（8K）——
 * 这些档位用户选不到、但降级提示里要说清楚「实际给的是什么」，所以单独补一份。
 * 认不出来的值原样回显，避免提示里出现 `undefined`。
 */
export function qualityLabel(qn: number): string {
  const labels: Record<number, string> = {
    127: '8K 超高清',
    126: '杜比视界',
    125: 'HDR 真彩',
    120: '4K 超清',
    116: '1080P 60帧',
    112: '1080P 高码率',
    80: '1080P',
    74: '720P 60帧',
    64: '720P',
    32: '480P',
    16: '360P'
  }
  return labels[qn] ?? `qn ${qn}`
}

/** ffmpeg 官方 Windows 构建下载页 */
export const FFMPEG_DOWNLOAD_URL = 'https://www.gyan.dev/ffmpeg/builds/'
