<script setup lang="ts">
import { computed, ref } from 'vue'
import { loadTree, toast } from '../store'

const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const paths = ref<string[]>([])
const bvid = ref('')
const busy = ref(false)
const preview = ref<{ name: string; count: number; warnings: string[] } | null>(null)

const fileNames = computed(() => paths.value.map((p) => p.split(/[\\/]/).pop() || p))

async function pick(): Promise<void> {
  const picked = await window.api.pickFiles()
  if (!picked.length) return
  paths.value = Array.from(new Set([...paths.value, ...picked]))
  await doPreview()
}

async function doPreview(): Promise<void> {
  const first = paths.value[0]
  if (!first) {
    preview.value = null
    return
  }
  try {
    const res = await window.api.previewSrt(first)
    preview.value = {
      name: fileNames.value[0],
      count: res.cues.length,
      warnings: res.warnings
    }
  } catch (err) {
    preview.value = { name: fileNames.value[0], count: 0, warnings: [(err as Error).message] }
  }
}

function removeAt(i: number): void {
  paths.value = paths.value.filter((_, idx) => idx !== i)
  void doPreview()
}

async function doImport(): Promise<void> {
  if (!paths.value.length) {
    toast('请先选择至少一个字幕文件', 'error')
    return
  }
  busy.value = true
  try {
    const res = await window.api.importSrt(paths.value, bvid.value.trim() || undefined)
    if (!res.ok || !res.data) {
      toast(res.message || '导入失败', 'error', 4000)
      return
    }
    await loadTree()
    const { imported, updated, failures, warnings, notes } = res.data
    const parts: string[] = []
    if (imported) parts.push(`新增 ${imported} 个`)
    if (updated) parts.push(`更新 ${updated} 个`)
    const summary = parts.length ? parts.join('，') : '没有导入任何字幕'
    const extras = [
      warnings.length ? `${warnings.length} 条格式提示` : '',
      notes.length ? `${notes.length} 条归类说明` : ''
    ].filter(Boolean)
    if (failures.length) {
      toast(
        `${summary}，失败 ${failures.length} 个：\n${failures.slice(0, 3).join('\n')}`,
        'error',
        5200
      )
    } else {
      toast(`${summary}${extras.length ? `（${extras.join('，')}）` : ''}`, 'success')
    }
    emit('done')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal">
      <h3>导入本地 SRT 字幕</h3>

      <div class="field">
        <label>字幕文件</label>
        <div class="row">
          <button class="btn" @click="pick">选择文件…</button>
          <span class="muted">支持 SRT / 常见字幕格式，自动识别 UTF-8 / GBK / UTF-16</span>
        </div>
      </div>

      <div v-if="paths.length" style="margin: 4px 0 10px 142px">
        <div
          v-for="(n, i) in fileNames"
          :key="n + i"
          class="range-item"
          style="margin-bottom: 4px"
        >
          <span style="flex: 1 1 auto; word-break: break-all">{{ n }}</span>
          <button class="del" @click="removeAt(i)">✕</button>
        </div>
      </div>

      <div class="field">
        <label>关联 BV 号</label>
        <div class="row">
          <input v-model="bvid" class="input grow" placeholder="可选，例如 BV1GJ411x7h7；填写后会拉取视频信息用于切片" />
        </div>
      </div>
      <div class="hint">
        不填 BV 号时，会先尝试从**文件名**里识别 BV 号并归到对应视频（同一个 UP主
        不管来自插件还是本地导入都在同一分组）；识别不到才归入「本地导入 / 本地文件」，
        这种情况下导出切片表会缺少 BV 号。
      </div>

      <div v-if="preview" class="field">
        <label>解析预览</label>
        <div class="row">
          <span class="muted">
            {{ preview.name }}：解析出 <strong>{{ preview.count }}</strong> 条字幕
            <template v-if="preview.warnings.length">
              （{{ preview.warnings.length }} 条格式提示）
            </template>
          </span>
        </div>
      </div>

      <div class="actions">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="busy || !paths.length" @click="doImport">
          {{ busy ? '导入中…' : '开始导入' }}
        </button>
      </div>
    </div>
  </div>
</template>
