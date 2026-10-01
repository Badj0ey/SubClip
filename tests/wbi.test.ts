/**
 * 插件端 WBI 签名算法的正确性测试。
 *
 * 直接从 extension/content.js 里提取 WBI 代码块来跑（而不是复制一份实现），
 * 保证测的就是插件实际执行的代码。
 * 运行：npm run test:wbi
 */
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT, PROTOCOL_VERSION } from '../extension/shared/protocol.js'
import { BRIDGE_PROTOCOL_VERSION } from '../src/shared/bridge'

interface WbiBundle {
  md5: (input: string) => string
  signWbi: (params: Record<string, unknown>, mixinKey: string) => Record<string, string>
  buildMixinKey: (imgUrl: string, subUrl: string) => string
  MIXIN_KEY_ENC_TAB: number[]
}

function loadWbi(): WbiBundle {
  const src = readFileSync(join(__dirname, '../extension/content.js'), 'utf8')
  const startMark = '/* ---- WBI-BLOCK-START'
  const endMark = '/* ---- WBI-BLOCK-END ---- */'
  const start = src.indexOf(startMark)
  const end = src.indexOf(endMark)
  assert.ok(start !== -1, 'content.js 里找不到 WBI-BLOCK-START 标记')
  assert.ok(end !== -1, 'content.js 里找不到 WBI-BLOCK-END 标记')

  const block = src.slice(src.indexOf('\n', start) + 1, end)
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    `${block}\nreturn { md5, signWbi, buildMixinKey, MIXIN_KEY_ENC_TAB }`
  )
  return factory() as WbiBundle
}

const { md5, signWbi, buildMixinKey, MIXIN_KEY_ENC_TAB } = loadWbi()

let passed = 0
let failed = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`)
  }
}

const nodeMd5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex')

console.log('\n【插件 WBI 签名】')

/* ---------------------------------- MD5 ---------------------------------- */
console.log('\nMD5 实现')

check('标准向量：空字符串', () => {
  assert.strictEqual(md5(''), 'd41d8cd98f00b204e9800998ecf8427e')
})

check('标准向量：abc', () => {
  assert.strictEqual(md5('abc'), '900150983cd24fb0d6963f7d28e17f72')
})

check('标准向量：长英文句', () => {
  assert.strictEqual(
    md5('The quick brown fox jumps over the lazy dog'),
    '9e107d9d372bb6826bd81d3542a419d6'
  )
})

check('标准向量：56 字节边界附近', () => {
  assert.strictEqual(md5('a'.repeat(55)), nodeMd5('a'.repeat(55)))
  assert.strictEqual(md5('a'.repeat(56)), nodeMd5('a'.repeat(56)))
  assert.strictEqual(md5('a'.repeat(64)), nodeMd5('a'.repeat(64)))
  assert.strictEqual(md5('a'.repeat(65)), nodeMd5('a'.repeat(65)))
})

check('中文（UTF-8 多字节）与 Node crypto 一致', () => {
  for (const s of ['你好', '中文字幕测试', '高光片段·第一段', 'emoji😀测试']) {
    assert.strictEqual(md5(s), nodeMd5(s), `不匹配：${s}`)
  }
})

check('与 Node crypto 大样本一致', () => {
  const samples = [
    'bvid=BV1GJ411x7h7&cid=123456&wts=1700000000',
    'a'.repeat(1000),
    'x'.repeat(997) + '中文' + 'y'.repeat(37),
    JSON.stringify({ bvid: 'BV1GJ411x7h7', page: 2, cid: 987654321 })
  ]
  for (const s of samples) {
    assert.strictEqual(md5(s), nodeMd5(s))
  }
})

/* ------------------------------- mixin key ------------------------------- */
console.log('\nWBI 密钥重排')

check('重排结果长度为 32 且只含十六进制字符', () => {
  const key = buildMixinKey(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
  )
  assert.strictEqual(key.length, 32)
  assert.ok(/^[0-9a-f]+$/.test(key), `含非十六进制字符：${key}`)
})

check('重排算法与参考实现一致', () => {
  const raw = '7cd084941338484aae1ad9425b84077c4932caff0ff746eab6f01bf08b70ac45'
  const expected = MIXIN_KEY_ENC_TAB.filter((i) => i < raw.length)
    .map((i) => raw[i])
    .join('')
    .slice(0, 32)
  const actual = buildMixinKey(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
  )
  assert.strictEqual(actual, expected)
})

check('密钥不足 32 位时报错', () => {
  assert.throws(() => buildMixinKey('https://x/a.png', 'https://x/b.png'), /WBI 签名密钥/)
})

/* -------------------------------- 签名结果 -------------------------------- */
console.log('\nWBI 签名')

const MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8'

check('签名的 w_rid 与 Node md5 复算一致', () => {
  const signed = signWbi({ bvid: 'BV1GJ411x7h7', cid: 123456 }, MIXIN_KEY)
  const withoutRid = Object.fromEntries(Object.entries(signed).filter(([k]) => k !== 'w_rid'))
  const query = new URLSearchParams(
    Object.keys(withoutRid)
      .sort()
      .map((k) => [k, withoutRid[k]] as [string, string])
  ).toString()
  assert.strictEqual(signed.w_rid, nodeMd5(query + MIXIN_KEY))
})

check('包含 wts 时间戳且为 10 位', () => {
  const signed = signWbi({ bvid: 'BV1' }, MIXIN_KEY)
  assert.ok(/^\d{10}$/.test(signed.wts), `wts 异常：${signed.wts}`)
})

check('参数按字典序排序后参与签名', () => {
  const a = signWbi({ cid: 1, bvid: 'BV1' }, MIXIN_KEY)
  const b = signWbi({ bvid: 'BV1', cid: 1 }, MIXIN_KEY)
  assert.strictEqual(a.w_rid, b.w_rid, '参数顺序不应影响签名')
})

check('过滤掉 null / undefined 参数', () => {
  const signed = signWbi({ bvid: 'BV1', cid: null, aid: undefined }, MIXIN_KEY)
  assert.ok(!('cid' in signed))
  assert.ok(!('aid' in signed))
})

check('剔除 !\'()* 特殊字符（与 B 站规则一致）', () => {
  const signed = signWbi({ keyword: "a!b'c(d)e*f" }, MIXIN_KEY)
  assert.strictEqual(signed.keyword, 'abcdef')
})

check('中文参数值不破坏签名计算', () => {
  const signed = signWbi({ keyword: '高光片段' }, MIXIN_KEY)
  const withoutRid = Object.fromEntries(Object.entries(signed).filter(([k]) => k !== 'w_rid'))
  const query = new URLSearchParams(
    Object.keys(withoutRid)
      .sort()
      .map((k) => [k, withoutRid[k]] as [string, string])
  ).toString()
  assert.strictEqual(signed.w_rid, nodeMd5(query + MIXIN_KEY))
})

/* --------------------------------- 协议 ---------------------------------- */
console.log('\n插件协议常量')

check('协议版本与默认端口和桌面端一致', () => {
  // 直接和桌面端常量对比，避免两边改了一边忘了另一边
  assert.strictEqual(PROTOCOL_VERSION, BRIDGE_PROTOCOL_VERSION)
  assert.strictEqual(DEFAULT_PORT, 8765)
})

check('应用与浏览器插件的版本号一致', () => {
  // 两边版本号曾经不一致（0.1.0 vs 1.0.0），发版时容易只改一边
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
  )
  assert.strictEqual(
    manifest.version,
    pkg.version,
    `package.json=${pkg.version} 与 extension/manifest.json=${manifest.version} 不一致`
  )
})

console.log(`\n通过 ${passed}，失败 ${failed}\n`)
if (failed > 0) process.exit(1)
