/**
 * 生成浏览器插件的固定 ID（manifest.json 的 `key` 字段）。
 *
 * 为什么需要它：桌面端的本地 WebSocket 只允许「我们自己这个扩展」连进来。
 * 解压加载的扩展 ID 默认由安装路径推导，每台机器都不一样，没法写死校验；
 * 在 manifest 里放一个固定的公钥，Chrome 就会用它算出**确定不变**的扩展 ID。
 *
 * 用法：node build/make-extension-key.mjs
 * 输出：manifest 里要填的 key（公钥，可公开）+ 对应的扩展 ID
 *
 * 注意：私钥不写入仓库。只有要发布到 Chrome 应用商店时才需要保留私钥，
 * 届时请自行生成并离线保管，不要提交。
 */
import { createHash, generateKeyPairSync } from 'node:crypto'

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const der = publicKey.export({ type: 'spki', format: 'der' })
const key = Buffer.from(der).toString('base64')

/** Chrome 用公钥 DER 的 SHA-256 前 16 字节映射成 a~p 的 32 位 ID */
function extensionIdFromKey(base64Key) {
  const digest = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest()
  let id = ''
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4))
    id += String.fromCharCode(97 + (digest[i] & 0x0f))
  }
  return id
}

const id = extensionIdFromKey(key)

console.log('把下面这行加进 extension/manifest.json（与 version 同级）：\n')
console.log(`  "key": "${key}",\n`)
console.log('对应的扩展 ID（填进 src/shared/bridge.ts 的 BRIDGE_EXTENSION_ID）：\n')
console.log(`  ${id}\n`)
