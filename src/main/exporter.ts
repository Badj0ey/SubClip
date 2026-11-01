/**
 * 切片表导出。
 *
 * 目标工具：D:\subtitle2clip\bilibili-slice-downloader
 * 它读取 Excel / CSV 表格，自动识别列：BV号 / 分P / 开始时间 / 结束时间 / 备注(文件名)。
 * 这里生成的表格完全对齐它的格式（含表头、HH:MM:SS 时间、UTF-8 BOM）。
 */
import { writeFileSync } from 'node:fs'
import { formatTime } from '@shared/time'
import type { SliceRowLike } from '@shared/types'

export type SliceRow = SliceRowLike

export const SLICE_HEADER = ['BV号', '分P', '开始时间', '结束时间', '备注(文件名)']

function csvCell(value: string): string {
  // 防公式注入：以 = + - @ 开头的单元格会被 Excel 当公式执行。
  // 前面加单引号强制按文本处理（OWASP CSV Injection 标准做法）。
  const safe = /^[=+\-@\t]/.test(value) ? `'${value}` : value
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`
  return safe
}

/** 生成 CSV 文本（带 BOM，Excel 直接打开不乱码） */
export function toCsv(rows: SliceRow[]): string {
  const lines = [SLICE_HEADER.join(',')]
  for (const r of rows) {
    lines.push(
      [
        // bvid 同样走 csvCell：导入的 JSON 里 bvid 未做格式校验，防公式注入
        csvCell(r.bvid ?? ''),
        String(r.page),
        formatTime(r.start),
        formatTime(r.end),
        csvCell(r.note ?? '')
      ].join(',')
    )
  }
  return '﻿' + lines.join('\r\n') + '\r\n'
}

export function writeCsv(path: string, rows: SliceRow[]): void {
  writeFileSync(path, toCsv(rows), 'utf8')
}

/** 生成 xlsx（列名与 CSV 一致） */
export function writeXlsx(path: string, rows: SliceRow[]): void {
  // CSV and startup must not eagerly load the relatively heavy SheetJS package.
  const XLSX = require('xlsx') as typeof import('xlsx')
  const aoa: (string | number)[][] = [SLICE_HEADER]
  for (const r of rows) {
    // 与 CSV 同理：= 开头的值在 Excel 里会被当公式，前面加单引号强制按文本处理
    aoa.push([csvCell(r.bvid ?? ''), r.page, formatTime(r.start), formatTime(r.end), csvCell(r.note ?? '')])
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 16 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 36 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '切片表')
  XLSX.writeFile(wb, path)
}

/** 依据切片行生成默认备注名 */
export function defaultNote(row: SliceRow): string {
  return row.note?.trim() || `${row.bvid}_P${row.page}_${formatTime(row.start).replace(/:/g, '')}`
}
