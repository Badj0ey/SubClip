/**
 * 生成应用图标（build/icon.ico + build/icon.png 预览）。
 *
 * 仓库里不放二进制设计文件，图标由这个脚本生成，改设计就改这里再跑一次：
 *   node build/make-icon.mjs
 *
 * 设计：B站粉的圆角方块 + 两条白色字幕条（下面一条短一些，读起来就是「字幕」），
 * 小尺寸下也能认出来。用 4 倍超采样再做降采样，边缘才不会有锯齿。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SIZE = 256
const SS = 4 // 超采样倍数
const BIG = SIZE * SS

/* ------------------------------- 形状与配色 ------------------------------- */

/** B站粉，纵向做一点点渐变 */
const BG_TOP = [255, 143, 177]
const BG_BOTTOM = [232, 90, 134]
const BAR = [255, 255, 255]

const RADIUS = Math.round(BIG * 0.22)

/** 点 (x,y) 是否落在圆角矩形内 */
function inRoundedRect(x, y, left, top, right, bottom, r) {
  if (x < left || x > right || y < top || y > bottom) return false
  const cx = Math.min(Math.max(x, left + r), right - r)
  const cy = Math.min(Math.max(y, top + r), bottom - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** 两条字幕条：上长下短 */
const bars = [
  { left: 0.2, right: 0.8, top: 0.4, bottom: 0.5 },
  { left: 0.2, right: 0.62, top: 0.58, bottom: 0.68 }
]

function renderBig() {
  const px = new Uint8Array(BIG * BIG * 4) // RGBA
  const barR = Math.round((bars[0].bottom - bars[0].top) * BIG * 0.5)

  for (let y = 0; y < BIG; y++) {
    const t = y / (BIG - 1)
    const bg = [
      Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
      Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
      Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
    ]
    for (let x = 0; x < BIG; x++) {
      const i = (y * BIG + x) * 4
      if (!inRoundedRect(x, y, 0, 0, BIG - 1, BIG - 1, RADIUS)) continue

      let rgb = bg
      for (const b of bars) {
        if (
          inRoundedRect(
            x,
            y,
            b.left * BIG,
            b.top * BIG,
            b.right * BIG,
            b.bottom * BIG,
            barR
          )
        ) {
          rgb = BAR
          break
        }
      }
      px[i] = rgb[0]
      px[i + 1] = rgb[1]
      px[i + 2] = rgb[2]
      px[i + 3] = 255
    }
  }
  return px
}

/** 超采样降采样到 SIZE×SIZE（按 alpha 加权，避免边缘发黑） */
function downsample(big) {
  const out = new Uint8Array(SIZE * SIZE * 4)
  const n = SS * SS
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * BIG + (x * SS + sx)) * 4
          const alpha = big[i + 3]
          r += big[i] * alpha
          g += big[i + 1] * alpha
          b += big[i + 2] * alpha
          a += alpha
        }
      }
      const o = (y * SIZE + x) * 4
      if (a === 0) continue
      out[o] = Math.round(r / a)
      out[o + 1] = Math.round(g / a)
      out[o + 2] = Math.round(b / a)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

/* --------------------------------- PNG 编码 -------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: None
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* --------------------------------- ICO 封装 -------------------------------- */

/** 单张 256×256 的 PNG 直接塞进 ICO（Vista 起支持 PNG 压缩的图标项） */
function encodeIco(png, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // count

  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size // 0 表示 256
  entry[1] = size >= 256 ? 0 : size
  entry[2] = 0 // palette
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32BE(0, 8)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12) // offset = 6 + 16

  return Buffer.concat([header, entry, png])
}

/* ----------------------------------- 输出 ---------------------------------- */

mkdirSync(here, { recursive: true })
const rgba = downsample(renderBig())
const png = encodePng(rgba, SIZE)

writeFileSync(join(here, 'icon.png'), png)
writeFileSync(join(here, 'icon.ico'), encodeIco(png, SIZE))

console.log(`icon.png  ${png.length} bytes`)
console.log(`icon.ico  ${encodeIco(png, SIZE).length} bytes`)
