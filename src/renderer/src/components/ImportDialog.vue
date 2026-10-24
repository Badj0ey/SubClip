<script setup lang="ts">
import { computed, ref } from 'vue'
import { loadTree, toast } from '../store'
import { useEscapeToClose } from '../composables/useEscapeToClose'

const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const paths = ref<string[]>([])
const bvid = ref('')
const busy = ref(false)

useEscapeToClose(() => emit('close'), () => !busy.value)
const preview = ref<{ name: string; count: number; warnings: string[] } | null>(null)

const fileNames = computed(() => paths.value.map((p) => p.split(/[\\/]/).pop() || p))

async function pick(): Promise<void> {
  if (busy.value) return
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
  if (busy.value) return
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
    if (!failures.length) emit('done')
  } catch (err) {
    toast(`导入时发生错误：${err instanceof Error ? err.message : '请稍后重试'}`, 'error', 5000)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <h3 id="import-dialog-title">导入字幕文件</h3>

      <div class="field">
        <label>字幕文件</label>
        <div class="row">
          <button class="btn" :disabled="busy" @click="pick">选择文件…</button>
          <span class="muted">支持 SRT、VTT、TXT 等格式，自动识别常见文本编码</span>
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
          <button class="del" :disabled="busy" :aria-label="`移除 ${n}`" @click="removeAt(i)">✕</button>
        </div>
      </div>

      <div class="field">
        <label>关联 B 站视频</label>
        <div class="row">
          <input v-model="bvid" class="input grow" placeholder="可选，例如 BV1GJ411x7h7；填写后会拉取视频信息用于切片" />
        </div>
      </div>
      <div class="hint">
        可以不填视频 BV 号。软件会先从文件名中识别；如果没有找到，就将字幕保存到“本地导入”。
        未关联 B 站视频的字幕仍可阅读和搜索，但无法直接获取对应的在线视频进行切片。
      </div>

      <div v-if="preview" class="field">
        <label>文件预览</label>
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
        <button class="btn" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="busy || !paths.length" @click="doImport">
          {{ busy ? '正在导入…' : '导入字幕' }}
        </button>
      </div>
    </div>
  </div>
</template>
