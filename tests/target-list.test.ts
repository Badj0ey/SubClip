/**
 * B站合集 / 系列 / 收藏夹批量解析的离线回归测试。
 * 通过 stub fetch 验证分页、去重、收藏夹 ID 与分页上限，不依赖真实账号或网络。
 */
import assert from 'node:assert/strict'
import { resolveTarget } from '../src/main/bilibili'

function response(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data
  } as Response
}

function bvid(index: number): string {
  return `BV${String(index).padStart(10, '0')}`
}

async function run(): Promise<void> {
  let passed = 0
  let failed = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      passed++
      console.log(`  ✓ ${name}`)
    } catch (err) {
      failed++
      console.error(`  ✗ ${name}\n      ${(err as Error).stack || (err as Error).message}`)
    }
  }

  console.log('\n【B站合集 / 系列 / 收藏夹批量解析】')
  const realFetch = globalThis.fetch

  await check('系列分页完整读取并按 BV 号去重', async () => {
    const requestedPages: number[] = []
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input))
      if (url.pathname === '/x/series/series') {
        return response({ code: 0, data: { meta: { name: '离线测试系列' } } })
      }
      if (url.pathname === '/x/series/archives') {
        const page = Number(url.searchParams.get('pn'))
        requestedPages.push(page)
        if (page === 1) {
          return response({
            code: 0,
            data: {
              page: { total: 31 },
              archives: Array.from({ length: 30 }, (_, i) => ({
                bvid: bvid(i + 1), title: `系列视频 ${i + 1}`
              }))
            }
          })
        }
        return response({
          code: 0,
          data: {
            page: { total: 31 },
            archives: [
              { bvid: bvid(30), title: '重复视频' },
              { bvid: bvid(31), title: '系列视频 31' }
            ]
          }
        })
      }
      throw new Error(`未预期的请求：${url.toString()}`)
    }) as typeof fetch

    const result = await resolveTarget(
      'https://space.bilibili.com/3546581515111228/lists/4130269?type=series',
      '',
      2
    )
    assert.equal(result.kind, 'series')
    assert.equal(result.title, '离线测试系列')
    assert.equal(result.videos.length, 31)
    assert.deepEqual(requestedPages, [1, 2])
    assert.equal(result.videos.at(-1)?.bvid, bvid(31))
    assert.equal(result.truncated, false)
  })

  await check('收藏夹使用 fid 作为 media_id，并跨页批量读取', async () => {
    const requestedMediaIds: string[] = []
    const requestedPages: number[] = []
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input))
      if (url.pathname === '/x/v3/fav/folder/info') {
        requestedMediaIds.push(url.searchParams.get('media_id') || '')
        return response({ code: 0, data: { title: '离线测试收藏夹' } })
      }
      if (url.pathname === '/x/v3/fav/resource/list') {
        requestedMediaIds.push(url.searchParams.get('media_id') || '')
        const page = Number(url.searchParams.get('pn'))
        requestedPages.push(page)
        if (page === 1) {
          return response({
            code: 0,
            data: {
              has_more: true,
              medias: Array.from({ length: 20 }, (_, i) => ({
                bvid: bvid(i + 101), title: `收藏视频 ${i + 1}`, type: 2
              }))
            }
          })
        }
        return response({
          code: 0,
          data: { has_more: false, medias: [{ bvid: bvid(121), title: '收藏视频 21', type: 2 }] }
        })
      }
      throw new Error(`未预期的请求：${url.toString()}`)
    }) as typeof fetch

    const result = await resolveTarget(
      'https://space.bilibili.com/500278643/favlist?fid=4262986443&ftype=create',
      '',
      2
    )
    assert.equal(result.kind, 'favlist')
    assert.equal(result.title, '离线测试收藏夹')
    assert.equal(result.videos.length, 21)
    assert.deepEqual(requestedPages, [1, 2])
    assert.ok(requestedMediaIds.length >= 3)
    assert.ok(requestedMediaIds.every((id) => id === '4262986443'))
    assert.equal(result.truncated, false)
  })

  await check('收藏夹达到分页上限时明确标记 truncated', async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input))
      if (url.pathname === '/x/v3/fav/folder/info') {
        return response({ code: 0, data: { title: '大收藏夹' } })
      }
      if (url.pathname === '/x/v3/fav/resource/list') {
        return response({
          code: 0,
          data: {
            has_more: true,
            medias: Array.from({ length: 20 }, (_, i) => ({
              bvid: bvid(i + 201), title: `视频 ${i + 1}`, type: 2
            }))
          }
        })
      }
      throw new Error(`未预期的请求：${url.toString()}`)
    }) as typeof fetch

    const result = await resolveTarget(
      'https://space.bilibili.com/500278643/favlist?fid=4262986443&ftype=create',
      '',
      1
    )
    assert.equal(result.videos.length, 20)
    assert.equal(result.truncated, true)
  })

  globalThis.fetch = realFetch
  console.log(`\n通过 ${passed}，失败 ${failed}\n`)
  if (failed > 0) process.exitCode = 1
}

void run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
