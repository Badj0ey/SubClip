/**
 * 从字体文件读出「字体族名」（写进 ASS 的 Fontname）。
 *
 * libass 按族名匹配字体，而文件名往往不等于族名（例如 msyh.ttc 的族名是
 * Microsoft YaHei），所以导入字体后必须解析一次。只支持 TrueType / OpenType
 * （含 TTC 集合）；解析失败时调用方回退用文件名。
 */

/**
 * 解析 sfnt name 表，返回族名；失败返回 null。
 * - 'ttcf' 集合：偏移 8 处的 u32 是第一个字体的偏移；
 * - name 表：base+2 count，base+4 stringOffset，记录从 base+6 起每 12 字节；
 * - nameID 1 = 族名（首选），16 = 排版族名（兜底）；
 * - platform 3（Windows）+ encoding 1（UTF-16BE）权重最高，platform 0（Unicode）次之。
 */
export function parseFontFamily(buffer: Buffer): string | null {
  try {
    if (buffer.length < 12) return null
    let offset = 0
    if (buffer.toString('ascii', 0, 4) === 'ttcf') {
      offset = buffer.readUInt32BE(8)
    }
    const numTables = buffer.readUInt16BE(offset + 4)
    let nameOffset = -1
    for (let i = 0; i < numTables; i++) {
      const rec = offset + 12 + i * 16
      if (buffer.toString('ascii', rec, rec + 4) === 'name') {
        nameOffset = buffer.readUInt32BE(rec + 8)
        break
      }
    }
    if (nameOffset < 0) return null
    const base = offset + nameOffset
    const count = buffer.readUInt16BE(base + 2)
    const stringOffset = base + buffer.readUInt16BE(base + 4)
    let best: { text: string; score: number } | null = null
    for (let i = 0; i < count; i++) {
      const rec = base + 6 + i * 12
      const platform = buffer.readUInt16BE(rec)
      const encoding = buffer.readUInt16BE(rec + 2)
      const nameId = buffer.readUInt16BE(rec + 6)
      const length = buffer.readUInt16BE(rec + 8)
      const off = buffer.readUInt16BE(rec + 10)
      let score = 0
      if (nameId === 1) score = platform === 3 ? 3 : platform === 0 ? 2 : 0
      else if (nameId === 16) score = platform === 3 ? 1 : platform === 0 ? 0.5 : 0
      if (!score) continue
      const raw = buffer.subarray(stringOffset + off, stringOffset + off + length)
      const text = decodeName(raw, platform, encoding)
      if (!text) continue
      if (!best || score > best.score) best = { text, score }
    }
    return best?.text ?? null
  } catch {
    return null
  }
}

/** 解码 name 表字符串：Windows / Unicode 平台的 UTF-16BE 字节交换成 utf16le */
function decodeName(raw: Buffer, platform: number, encoding: number): string | null {
  try {
    const isUtf16be = platform === 0 || (platform === 3 && encoding === 1)
    if (!isUtf16be) return null
    const out = Buffer.alloc(raw.length)
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out[i] = raw[i + 1]
      out[i + 1] = raw[i]
    }
    return out.toString('utf16le').replace(/\0+$/, '')
  } catch {
    return null
  }
}
