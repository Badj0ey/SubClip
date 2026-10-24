<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { DashboardFavorite, DashboardOverview } from '@shared/types'
import { useResourceStore } from '../stores/resource'
import { useSubtitleStore } from '../stores/subtitle'
import { useUiStore } from '../stores/ui'
import { useJobsStore } from '../stores/jobs'
import UiIcon from './UiIcon.vue'

const emit = defineEmits<{ (e: 'import'): void; (e: 'pull'): void }>()
const resource = useResourceStore()
const subtitle = useSubtitleStore()
const ui = useUiStore()
const jobs = useJobsStore()
const data = ref<DashboardOverview | null>(null)
const loading = ref(true)

const metrics = computed(() => [
  { label: '视频素材', value: data.value?.totalVideos ?? 0, icon: 'video' as const, hint: '已收录视频', view: 'library' as const },
  { label: '字幕文档', value: data.value?.totalDocs ?? 0, icon: 'file-text' as const, hint: '可检索字幕', view: 'search' as const },
  { label: '保存片段', value: data.value?.clipCount ?? 0, icon: 'scissors' as const, hint: '创作素材', view: 'clips' as const },
  { label: '待输出任务', value: jobs.pending.length, icon: 'queue' as const, hint: '等待剪辑', view: 'clipjobs' as const }
])

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const [overview] = await Promise.all([window.api.dashboardOverview(), jobs.load()])
    data.value = overview
  } catch (error) {
    ui.showToast(`工作台加载失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000)
  } finally {
    loading.value = false
  }
}
onMounted(() => { void refresh() })

async function openVideo(videoId: number, docId: number | null): Promise<void> {
  ui.setView('library')
  const key = `video:${videoId}`
  resource.activeKey = key
  resource.expandTo(key)
  if (docId != null) await subtitle.open(docId)
  else ui.showToast('这个视频还没有字幕，可以从「拉取字幕」补齐', 'info', 4000)
}
function openCollection(id: number): void {
  ui.setView('library')
  resource.expandTo(`collection:${id}`)
}
async function openFavorite(item: DashboardFavorite): Promise<void> {
  ui.setView('library')
  resource.activeKey = item.key
  resource.expandTo(item.key)
  if (item.docId != null) await subtitle.open(item.docId)
}
function openClip(id: number): void {
  ui.focusClipId = id
  ui.setView('clips')
}
function fmt(ts: number): string {
  if (!ts) return '—'
  const date = new Date(ts)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}
</script>

<template>
  <section class="dashboard" aria-label="工作台">
    <div class="dashboard-inner">
      <header class="dash-hero">
        <div class="hero-copy">
          <div class="hero-eyebrow"><span class="eyebrow-dot"></span> YOUR CREATIVE WORKSPACE <span class="eyebrow-sep"></span> 字幕剪 SubClip</div>
          <h1>每一句字幕，<br /><span>都是下一段灵感。</span></h1>
          <p>从发现精彩对白，到整理片段、批量剪辑与发布。<br />让视频创作，从这里流畅开始。</p>
          <div class="hero-actions">
            <button class="hero-primary" type="button" @click="emit('pull')">
              <UiIcon name="download" :size="17" /> 拉取 B 站字幕 <UiIcon name="arrow-right" :size="16" />
            </button>
            <button class="hero-secondary" type="button" @click="emit('import')">
              <UiIcon name="upload" :size="17" /> 导入本地字幕
            </button>
          </div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div>
          <div class="art-screen">
            <div class="art-screen-top"><span></span><span></span><span></span><i>SUBTITLE / EDIT</i></div>
            <div class="art-wave">
              <i v-for="height in [22, 35, 17, 50, 68, 37, 84, 59, 44, 73, 48, 92, 61, 34, 71, 42, 24, 55, 30, 16]" :key="height" :style="{ height: `${height}%` }"></i>
            </div>
            <div class="art-timeline"><span></span><span></span><span></span><span></span><span></span></div>
            <div class="art-caption"><b>00:42</b><span>把喜欢的瞬间，变成自己的作品</span></div>
          </div>
          <div class="art-floating"><UiIcon name="sparkles" :size="17" /><span>灵感已捕捉</span><UiIcon name="check" :size="15" /></div>
          <span class="art-spark spark-one">✦</span><span class="art-spark spark-two">✧</span>
        </div>
      </header>

      <div class="dash-section-heading">
        <div><span class="section-kicker">OVERVIEW</span><h2>工作台概览</h2></div>
        <button class="btn dash-refresh" type="button" :disabled="loading" @click="refresh">
          <UiIcon name="refresh" :size="16" /> 刷新数据
        </button>
      </div>

      <div class="metric-grid">
        <button v-for="metric in metrics" :key="metric.label" class="metric-card" type="button" @click="ui.setView(metric.view)">
          <span class="metric-top"><span class="metric-icon"><UiIcon :name="metric.icon" :size="19" /></span><UiIcon name="arrow-up-right" :size="17" /></span>
          <strong>{{ loading && !data ? '—' : metric.value.toLocaleString('zh-CN') }}</strong>
          <span class="metric-label">{{ metric.label }} <small>{{ metric.hint }}</small></span>
        </button>
      </div>

      <div class="dash-grid">
        <section class="dash-card quick">
          <header class="dash-card-head"><div><span class="section-kicker">QUICK START</span><h3>快捷开始</h3></div></header>
          <div class="quick-grid">
            <button class="quick-btn" type="button" @click="emit('import')"><span class="q-ico violet"><UiIcon name="upload" :size="20" /></span><strong>导入字幕</strong><small>SRT / VTT / TXT</small></button>
            <button class="quick-btn" type="button" @click="emit('pull')"><span class="q-ico blue"><UiIcon name="download" :size="20" /></span><strong>拉取字幕</strong><small>B 站视频与合集</small></button>
            <button class="quick-btn" type="button" @click="ui.setView('search')"><span class="q-ico amber"><UiIcon name="search" :size="20" /></span><strong>全文检索</strong><small>快速定位精彩片段</small></button>
            <button class="quick-btn" type="button" @click="ui.setView('clips')"><span class="q-ico green"><UiIcon name="scissors" :size="20" /></span><strong>片段库</strong><small>整理你的创作灵感</small></button>
          </div>
        </section>

        <section class="dash-card pending">
          <header class="dash-card-head"><div><span class="section-kicker">NEXT UP</span><h3>接下来做什么</h3></div><UiIcon name="clock" :size="19" /></header>
          <ul class="todo-list">
            <li><span class="todo-n">{{ jobs.pending.length }}</span><span class="todo-t">待执行的剪辑任务</span><button class="todo-link" type="button" @click="ui.setView('clipjobs')">查看 <UiIcon name="arrow-right" :size="14" /></button></li>
            <li><span class="todo-n">{{ data?.videosWithoutDocs ?? 0 }}</span><span class="todo-t">个视频等待补齐字幕</span><button class="todo-link" type="button" @click="emit('pull')">拉取 <UiIcon name="arrow-right" :size="14" /></button></li>
            <li><span class="todo-n" :class="{ danger: jobs.failed.length }">{{ jobs.failed.length }}</span><span class="todo-t">条任务需要处理</span><button class="todo-link" type="button" @click="ui.setView('clipjobs')">处理 <UiIcon name="arrow-right" :size="14" /></button></li>
          </ul>
        </section>

        <section class="dash-card span2 recent">
          <header class="dash-card-head"><div><span class="section-kicker">RECENT MEDIA</span><h3>最近视频 <small>按字幕入库时间</small></h3></div><button class="text-link" type="button" @click="ui.setView('library')">查看素材库 <UiIcon name="arrow-right" :size="15" /></button></header>
          <div v-if="loading && !data" class="dash-loading">正在读取最近素材…</div>
          <div v-else-if="!data?.recentVideos.length" class="dash-empty"><UiIcon name="video" :size="25" /><strong>还没有视频素材</strong><span>导入一份字幕，或从 B 站拉取视频字幕即可开始。</span></div>
          <ul v-else class="video-list">
            <li v-for="(video, index) in data.recentVideos" :key="video.videoId" class="video-row">
              <span class="video-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <button class="video-main" type="button" @click="openVideo(video.videoId, video.firstDocId)">
                <span class="video-title">{{ video.title }}</span>
                <span class="video-meta">{{ video.uploaderName }}<template v-if="video.collectionTitle"> · {{ video.collectionTitle }}</template> · {{ video.docCount }} 份字幕</span>
              </button>
              <span class="video-date">{{ fmt(video.createdAt) }}</span>
              <button class="video-open" type="button" :aria-label="`打开 ${video.title}`" @click="openVideo(video.videoId, video.firstDocId)"><UiIcon name="arrow-right" :size="16" /></button>
            </li>
          </ul>
        </section>

        <section class="dash-card">
          <header class="dash-card-head"><div><span class="section-kicker">COLLECTIONS</span><h3>最近项目</h3></div><UiIcon name="folder" :size="19" /></header>
          <div v-if="!data?.recentCollections.length" class="dash-empty compact"><UiIcon name="folder" :size="23" /><span>暂无合集，拉取合集字幕后会显示在这里。</span></div>
          <ul v-else class="mini-list">
            <li v-for="collection in data.recentCollections" :key="collection.collectionId">
              <button class="mini-main" type="button" @click="openCollection(collection.collectionId)"><span class="mini-icon"><UiIcon name="folder" :size="16" /></span><span class="mini-copy"><strong>{{ collection.title }}</strong><small>{{ collection.uploaderName }} · {{ collection.videoCount }} 个视频</small></span><UiIcon name="chevron-right" :size="16" /></button>
            </li>
          </ul>
        </section>

        <section class="dash-card">
          <header class="dash-card-head"><div><span class="section-kicker">SAVED MOMENTS</span><h3>我的收藏</h3></div><UiIcon name="star" :size="19" /></header>
          <div v-if="!data?.favoriteClips.length && !data?.favorites.length" class="dash-empty compact"><UiIcon name="star" :size="23" /><span>收藏喜欢的字幕和片段，随时回来继续创作。</span></div>
          <ul v-else class="mini-list">
            <li v-for="clip in data.favoriteClips" :key="`clip-${clip.id}`"><button class="mini-main" type="button" @click="openClip(clip.id)"><span class="mini-icon favorite"><UiIcon name="scissors" :size="16" /></span><span class="mini-copy"><strong>{{ clip.name }}</strong><small>片段 · P{{ clip.page }} · {{ Math.max(0, Math.round(clip.end - clip.start)) }} 秒</small></span><UiIcon name="chevron-right" :size="16" /></button></li>
            <li v-for="favorite in data.favorites" :key="favorite.key"><button class="mini-main" type="button" @click="openFavorite(favorite)"><span class="mini-icon favorite"><UiIcon name="star" :size="16" /></span><span class="mini-copy"><strong>{{ favorite.label }}</strong><small>{{ favorite.type === 'doc' ? '字幕' : favorite.type === 'video' ? '视频' : favorite.type === 'collection' ? '合集' : 'UP主' }}</small></span><UiIcon name="chevron-right" :size="16" /></button></li>
          </ul>
        </section>
      </div>
      <footer class="dashboard-footer"><span>SUBCLIP · MAKE EVERY MOMENT COUNT</span><span>本地素材库 · AI 服务按需启用</span></footer>
    </div>
  </section>
</template>

<style scoped>
.dashboard { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 28px 32px 40px; background: var(--bg); }
.dashboard-inner { max-width: 1510px; margin: 0 auto; }
.dash-hero { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(350px, .95fr); min-height: 278px; overflow: hidden; position: relative; border-radius: 22px; background: linear-gradient(118deg, #172b59 0%, #253b78 50%, #514c9a 100%); color: #fff; }
.dash-hero::before { content: ''; position: absolute; inset: 0; opacity: .36; background: radial-gradient(circle at 76% 15%, rgba(188, 197, 255, .34), transparent 38%); pointer-events: none; }
.hero-copy { position: relative; z-index: 2; padding: 30px 22px 32px 42px; }
.hero-eyebrow { display: flex; align-items: center; gap: 9px; font-size: 10px; font-weight: 700; letter-spacing: .13em; color: #bfc9f8; }
.eyebrow-dot { width: 7px; height: 7px; border-radius: 50%; background: #b1e4c8; box-shadow: 0 0 0 4px rgba(177, 228, 200, .13); }
.eyebrow-sep { height: 12px; width: 1px; background: rgba(255,255,255,.28); }
.hero-copy h1 { margin: 23px 0 11px; font-size: clamp(26px, 2.4vw, 37px); line-height: 1.34; letter-spacing: -.045em; font-weight: 720; }
.hero-copy h1 span { color: #c7d1ff; }
.hero-copy p { margin: 0; font-size: 12.5px; line-height: 1.85; color: #c5d1f1; }
.hero-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
.hero-primary, .hero-secondary { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 39px; padding: 0 16px; border: 1px solid transparent; border-radius: 9px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
.hero-primary { background: #fff; color: #24386b; box-shadow: 0 5px 15px rgba(9, 20, 48, .15); }
.hero-primary:hover { background: #eaf0ff; }
.hero-secondary { border-color: rgba(232, 238, 255, .35); color: #f1f4ff; background: rgba(255,255,255,.1); }
.hero-secondary:hover { background: rgba(255,255,255,.2); }
.hero-art { position: relative; min-height: 260px; display: flex; align-items: center; justify-content: center; }
.art-orbit { position: absolute; width: 350px; height: 350px; border: 1px solid rgba(219,227,255,.17); border-radius: 50%; transform: rotate(-16deg) scaleX(1.22); }
.orbit-two { width: 460px; height: 460px; opacity: .6; }
.art-screen { position: relative; width: min(84%, 395px); height: 205px; padding: 0 19px 15px; border: 1px solid rgba(222, 229, 255, .34); border-radius: 13px; background: rgba(20, 35, 81, .85); box-shadow: 0 26px 45px rgba(5, 12, 41, .36); transform: rotate(-4deg); }
.art-screen-top { height: 37px; display: flex; align-items: center; gap: 5px; border-bottom: 1px solid rgba(255,255,255,.12); }
.art-screen-top span { width: 6px; height: 6px; border-radius: 50%; background: #657bb3; }
.art-screen-top span:first-child { background: #f3a99f; }.art-screen-top span:nth-child(2) { background: #f0d093; }
.art-screen-top i { margin-left: auto; font-size: 8px; letter-spacing: .15em; font-style: normal; color: #a2b6e6; }
.art-wave { height: 87px; display: flex; align-items: center; justify-content: space-between; gap: 5px; padding: 12px 2px 5px; }
.art-wave i { display: block; width: 6px; flex: 1; max-width: 10px; border-radius: 10px; background: linear-gradient(#b3b7ff, #6a91ed); opacity: .85; }
.art-wave i:nth-child(3n) { background: #73c8ca; }
.art-timeline { display: flex; gap: 5px; height: 17px; margin: 0 0 8px; }
.art-timeline span { flex: 1; border-radius: 3px; background: #516da8; }.art-timeline span:nth-child(2) { flex: 1.8; background: #7b8ee8; }.art-timeline span:nth-child(4) { flex: 1.5; background: #73c8ca; }
.art-caption { display: flex; align-items: center; gap: 9px; height: 31px; padding: 0 9px; border-radius: 5px; background: rgba(8, 19, 46, .54); font-size: 10px; color: #e8edff; }
.art-caption b { font-size: 10px; color: #8fdfdf; font-variant-numeric: tabular-nums; }
.art-floating { position: absolute; z-index: 2; right: 10%; bottom: 17px; display: flex; align-items: center; gap: 7px; padding: 10px 12px; border-radius: 10px; background: #fff; color: #25366e; font-size: 10px; font-weight: 700; box-shadow: 0 13px 25px rgba(7, 13, 45, .26); transform: rotate(3deg); }
.art-floating svg:first-child { color: #7767d9; }.art-floating svg:last-child { color: #32a685; }
.art-spark { position: absolute; color: #f2dba9; }.spark-one { right: 14%; top: 22px; font-size: 26px; }.spark-two { left: 6%; bottom: 32px; font-size: 21px; }
.dash-section-heading { display: flex; align-items: flex-end; gap: 16px; margin: 27px 0 14px; }
.section-kicker { color: var(--accent); font-size: 9px; letter-spacing: .16em; font-weight: 800; }
.dash-section-heading h2 { margin: 3px 0 0; font-size: 20px; font-weight: 750; letter-spacing: -.03em; }
.dash-refresh { margin-left: auto; color: var(--text-dim); }
.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.metric-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 17px 19px; border: 1px solid var(--border); border-radius: 15px; text-align: left; color: var(--text); background: var(--panel); cursor: pointer; transition: box-shadow .18s, transform .18s, border-color .18s; }
.metric-card:hover { border-color: var(--border-strong); transform: translateY(-2px); box-shadow: var(--shadow); }
.metric-top { display: flex; align-items: center; justify-content: space-between; color: var(--text-dim); }
.metric-icon { display: grid; place-items: center; width: 37px; height: 37px; border-radius: 11px; color: var(--accent); background: var(--accent-soft); }
.metric-card strong { font-size: 28px; line-height: 1.05; letter-spacing: -.045em; font-variant-numeric: tabular-nums; }
.metric-label { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 12px; font-weight: 700; }
.metric-label small { color: var(--text-dim); font-size: 11px; font-weight: 400; }
.dash-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.dash-card { min-width: 0; padding: 20px; border: 1px solid var(--border); border-radius: 15px; background: var(--panel); }
.dash-card.span2 { grid-column: span 2; }
.dash-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; color: var(--text-dim); }
.dash-card-head h3 { margin: 3px 0 0; color: var(--text); font-size: 15px; font-weight: 730; }
.dash-card-head h3 small { color: var(--text-dim); font-size: 11px; font-weight: 400; }
.quick-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.quick-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 14px 10px; min-width: 0; border: 1px solid var(--hairline); border-radius: 11px; color: var(--text); background: var(--bg); text-align: left; cursor: pointer; }
.quick-btn:hover { border-color: var(--accent); background: var(--accent-soft); }
.q-ico { display: grid; place-items: center; width: 35px; height: 35px; margin-bottom: 3px; border-radius: 10px; }
.q-ico.violet { color: #7668da; background: #eeebff; }.q-ico.blue { color: #3d7fc7; background: #e6f2ff; }.q-ico.amber { color: #b37b20; background: #fff1d8; }.q-ico.green { color: #219478; background: #e3f8f0; }
.quick-btn strong { font-size: 12px; white-space: nowrap; }.quick-btn small { font-size: 10px; color: var(--text-dim); line-height: 1.4; }
.todo-list { list-style: none; margin: 0; padding: 0; }
.todo-list li { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--hairline); }
.todo-list li:last-child { border-bottom: 0; }
.todo-n { display: grid; place-items: center; width: 33px; height: 33px; flex: 0 0 33px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; }
.todo-n.danger { background: var(--danger-soft); color: var(--danger); }
.todo-t { flex: 1; min-width: 0; color: var(--text); font-size: 12px; }
.todo-link, .text-link { display: inline-flex; align-items: center; gap: 5px; padding: 6px; border: 0; border-radius: 6px; background: transparent; color: var(--accent); font: inherit; font-size: 11px; font-weight: 650; cursor: pointer; white-space: nowrap; }
.todo-link:hover, .text-link:hover { background: var(--accent-soft); }
.video-list, .mini-list { list-style: none; margin: 0; padding: 0; max-height: 330px; overflow: auto; }
.video-row { display: flex; align-items: center; gap: 14px; padding: 8px 9px; border-bottom: 1px solid var(--hairline); border-radius: 8px; }
.video-row:last-child { border-bottom: 0; }.video-row:hover { background: var(--row-hover); }
.video-index { width: 28px; color: var(--text-dim); font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
.video-main { display: flex; flex: 1; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; padding: 4px 0; border: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.video-title { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 650; }
.video-meta { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-size: 11px; }
.video-date { color: var(--text-dim); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.video-open { display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 7px; color: var(--text-dim); background: transparent; cursor: pointer; }
.video-open:hover { background: var(--accent-soft); color: var(--accent); }
.mini-main { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 6px; border: 0; border-radius: 9px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.mini-main:hover { background: var(--row-hover); }
.mini-icon { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 32px; border-radius: 9px; color: var(--accent); background: var(--accent-soft); }
.mini-icon.favorite { color: #b67a2a; background: var(--warn-soft); }
.mini-copy { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.mini-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 650; }
.mini-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-dim); }
.mini-main > svg:last-child { color: var(--text-dim); }
.dash-empty, .dash-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 160px; text-align: center; color: var(--text-dim); font-size: 12px; }
.dash-empty svg { color: var(--accent); opacity: .65; }.dash-empty strong { color: var(--text); font-size: 13px; }.dash-empty.compact { min-height: 110px; padding: 12px; }
.dashboard-footer { display: flex; justify-content: space-between; gap: 10px; margin-top: 24px; color: var(--text-dim); font-size: 10px; letter-spacing: .04em; }
@media (max-width: 1250px) { .dashboard { padding: 24px; }.dash-hero { grid-template-columns: 1fr 0.85fr; }.hero-copy { padding-left: 28px; }.hero-copy h1 { font-size: 29px; }.quick-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 980px) { .dash-hero { grid-template-columns: 1fr; }.hero-art { display: none; }.metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.dash-grid { grid-template-columns: 1fr; }.dash-card.span2 { grid-column: auto; } }
@media (prefers-reduced-motion: reduce) { .metric-card { transition: none; }.metric-card:hover { transform: none; } }
</style>
