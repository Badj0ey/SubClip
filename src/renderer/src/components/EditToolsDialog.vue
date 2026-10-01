<script setup lang="ts">
/**
 * 字幕工具：批量替换 / 时间轴调整 / 导出 / 复制。
 *
 * 都作用于**当前打开的文档**（不是合并后的整条列表），
 * 因为时间轴调整这类操作按分P 单独做才可预期。
 */
import { computed, ref } from 'vue'
import {
  copySelectedText,
  copyTimestampLink,
  pushUndo,
  reloadActiveDoc,
  state,
  toast
} from '../store'

const emit = defineEmits<{ (e: 'close'): void }>()

const docId = computed(() => state.doc?.id ?? null)
const busy = ref(false)

/* ------------------------------- 查找替换 ------------------------------- */

const pattern = ref('')
const replacement = ref('')
const useRegex = ref(false)
const ignoreCase = ref(false)

async function doReplace(): Promise<void> {
  const id = docId.value
  if (id == null) return
  if (!pattern.value) {
    toast('请先填写要查找的内容', 'error')
    return
  }
  busy.value = true
  try {
    await pushUndo(id, `批量替换「${pattern.value}」`)
    const res = await window.api.replaceInDoc({
      docId: id,
      pattern: pattern.value,
      replacement: replacement.value,
      useRegex: useRegex.value,
      ignoreCase: ignoreCase.value
    })
    if (!res.ok || !res.data) {
      toast(res.message || '替换失败', 'error', 4600)
      return
    }
    await reloadActiveDoc()
    const { changed, total } = res.data
    toast(
      changed ? `已替换 ${changed} / ${total} 条字幕` : '没有匹配到任何内容，未做改动',
      changed ? 'success' : 'info'
    )
  } finally {
    busy.value = false
  }
}

/* ------------------------------- 时间轴 ------------------------------- */

const offsetMs = ref(0)
const scale = ref(1)

async function doShift(): Promise<void> {
  const id = docId.value
  if (id == null) return
  if (!offsetMs.value && scale.value === 1) {
    toast('平移和倍速都没有变化', 'info')
    return
  }
  busy.value = true
  try {
    await pushUndo(id, `时间轴调整（${offsetMs.value}ms × ${scale.value}）`)
    const res = await window.api.shiftDocTime({
      docId: id,
      offsetMs: offsetMs.value,
      scale: scale.value
    })
    if (!res.ok) {
      toast(res.message || '调整失败', 'error')
      return
    }
    await reloadActiveDoc()
    toast(`已调整 ${res.data?.count ?? 0} 条字幕的时间轴`, 'success')
  } finally {
    busy.value = false
  }
}

function resetShift(): void {
  offsetMs.value = 0
  scale.value = 1
}

/* ------------------------------- 导出 / 复制 ------------------------------ */

const format = ref<'srt' | 'vtt' | 'txt'>('srt')
const allPages = ref(false)

async function doExport(): Promise<void> {
  const id = docId.value
  if (id == null) return
  busy.value = true
  try {
    const res = await window.api.exportDocAs({
      docId: id,
      format: format.value,
      includeAllPages: allPages.value
    })
    if (!res.ok || !res.data) {
      if (res.message !== '已取消') toast(res.message || '导出失败', 'error', 4600)
      return
    }
    toast(`已导出 ${res.data.count} 条字幕：${res.data.path}`, 'success', 5600)
    await window.api.showItem(res.data.path)
  } finally {
    busy.value = false
  }
}

async function doCopyText(): Promise<void> {
  await copySelectedText()
}

async function doCopyLink(): Promise<void> {
  await copyTimestampLink()
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal" style="width: 620px">
      <h3>字幕工具</h3>
      <div v-if="!state.doc" class="hint">请先打开一个字幕文档。</div>

      <template v-else>
        <div class="hint" style="margin-left: 0">
          当前文档：<strong>{{ state.doc.label }}</strong> · 第 {{ state.doc.page }} P ·
          {{ state.cues.length }} 条字幕
        </div>

        <!-- 批量替换 -->
        <div class="seg" style="margin-top: 10px">
          <div class="seg-title">批量查找替换</div>
          <div class="field">
            <label>查找</label>
            <div class="row">
              <input v-model="pattern" class="input grow" spellcheck="false" placeholder="要查找的内容" />
            </div>
          </div>
          <div class="field">
            <label>替换为</label>
            <div class="row">
              <input v-model="replacement" class="input grow" spellcheck="false" placeholder="留空即删除" />
            </div>
          </div>
          <div class="opt-row">
            <label class="opt"><input v-model="useRegex" type="checkbox" />正则表达式</label>
            <label class="opt"><input v-model="ignoreCase" type="checkbox" />忽略大小写</label>
            <span class="grow"></span>
            <button class="btn primary" :disabled="busy || !pattern" @click="doReplace">替换</button>
          </div>
          <div class="hint" style="margin-left: 0">
            正则模式下替换文本可用 <code>$1</code> 引用捕获组；不勾选正则时按纯文本匹配，特殊字符无需转义。
          </div>
        </div>

        <!-- 时间轴 -->
        <div class="seg" style="margin-top: 10px">
          <div class="seg-title">时间轴调整</div>
          <div class="field">
            <label>整体平移</label>
            <div class="row">
              <input v-model.number="offsetMs" class="input" type="number" style="width: 130px" />
              <span class="muted">毫秒（可为负）</span>
              <span class="grow"></span>
              <button class="btn sm" @click="offsetMs = -500">−500</button>
              <button class="btn sm" @click="offsetMs = 500">+500</button>
            </div>
          </div>
          <div class="field">
            <label>倍速缩放</label>
            <div class="row">
              <input v-model.number="scale" class="input" type="number" step="0.001" style="width: 130px" />
              <span class="muted">1 = 不变；围绕第一条字幕的起点缩放</span>
            </div>
          </div>
          <div class="opt-row">
            <span class="grow"></span>
            <button class="btn sm" @click="resetShift">清零</button>
            <button class="btn primary" :disabled="busy" @click="doShift">应用</button>
          </div>
        </div>

        <!-- 导出 / 复制 -->
        <div class="seg" style="margin-top: 10px">
          <div class="seg-title">导出 / 复制</div>
          <div class="opt-row">
            <select v-model="format" class="input" style="width: 120px">
              <option value="srt">SRT</option>
              <option value="vtt">WebVTT</option>
              <option value="txt">纯文本</option>
            </select>
            <label class="opt"><input v-model="allPages" type="checkbox" />包含该视频全部分P</label>
            <span class="grow"></span>
            <button class="btn" :disabled="busy" @click="doExport">导出…</button>
          </div>
          <div class="opt-row">
            <button class="btn sm" @click="doCopyText">复制字幕文本</button>
            <button class="btn sm" @click="doCopyLink">复制带时间戳的链接</button>
            <span class="muted" style="font-size: 12px">
              复制文本：有选中就复制选中的，没选中就复制全部
            </span>
          </div>
        </div>
      </template>

      <div class="actions">
        <span class="muted" style="margin-right: auto; font-size: 12px">
          改动可用工具栏的「撤销」回退（内存里保留最近 20 步）
        </span>
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 弹窗里的这些行要「横向排开」。
 * 全局的 .row / .field label 是按「左侧标签列 + 右侧控件」设计的，
 * 直接复用会把复选框和按钮挤成竖排，所以这里单独定一套。
 */
.opt-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
  flex-wrap: wrap;
}

.opt-row :deep(label),
.opt-row label.opt {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: auto;
  flex: 0 0 auto;
  font-weight: normal;
  color: var(--text);
  white-space: nowrap;
}
</style>
