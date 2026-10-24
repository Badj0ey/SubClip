<script setup lang="ts">
/** One consistent 24px outline icon language; no icon-font or CDN dependency. */
const paths = {
  home: ['M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z'],
  library: ['M4 4h6v16H4z', 'M10 4h6v16h-6z', 'M17 6l3-1 2 14-3 1z'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16', 'm17 17 4 4'],
  scissors: ['M9 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0', 'M9 17a3 3 0 1 1-6 0 3 3 0 0 1 6 0', 'M8.2 9.2 21 21', 'M14.1 14.1 21 7', 'M8.2 14.8 12 11'],
  queue: ['M4 6h12', 'M4 12h12', 'M4 18h9', 'm17 15 3 3-3 3'],
  settings: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7', 'M19.4 15.5 21 17l-2 3-2.2-.7-1.6 1.2-3.2.5-1.3-1.9-2-.4-1.9 1.3L4 17l1.6-1.5-.3-2L3 12l2.3-1.5.3-2L4 7l2.6-3 1.9 1.3 2-.4L11.8 3l3.2.5 1.6 1.2L18.8 4 21 7l-1.6 1.5.3 2L22 12l-2.3 1.5z'],
  sun: ['M12 3v2', 'M12 19v2', 'M3 12h2', 'M19 12h2', 'm5.6 5.6 1.4 1.4', 'm17 17 1.4 1.4', 'm5.6 18.4 1.4-1.4', 'm17 7 1.4-1.4', 'M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0'],
  moon: ['M20 14.1A8.5 8.5 0 0 1 9.9 4a8.5 8.5 0 1 0 10.2 10.1z'],
  monitor: ['M3 5h18v12H3z', 'M8 21h8', 'M12 17v4'],
  upload: ['M12 16V3', 'm7 8 5-5 5 5', 'M4 16v4h16v-4'],
  download: ['M12 3v13', 'm-5-5 5 5 5-5', 'M4 17v4h16v-4'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6 9a7 7 0 0 1 12-2l2 5', 'M18 15a7 7 0 0 1-12 2l-2-5'],
  panel: ['M3 4h18v16H3z', 'M9 4v16'],
  command: ['M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2z'],
  'chevron-right': ['m9 5 7 7-7 7'],
  'arrow-right': ['M4 12h16', 'm14 6 6 6-6 6'],
  'file-text': ['M6 2h8l5 5v15H6z', 'M14 2v5h5', 'M9 12h7', 'M9 16h7'],
  sparkles: ['m12 2 2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2z', 'm19 19 1 2 2 1'],
  play: ['m8 5 11 7-11 7z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18', 'M12 7v5l3 2'],
  folder: ['M3 7h7l2 2h9v11H3z', 'M3 7V5h8l2 2'],
  star: ['m12 2 3.1 6.5 7.2 1-5.2 5.1 1.2 7.2L12 17.7l-6.1 3.4 1.2-7.2-5.2-5.1 7.2-1z'],
  video: ['M3 5h18v14H3z', 'm10 9 6 3-6 3z'],
  check: ['m4 12 5 5L20 6'],
  close: ['M5 5l14 14', 'M19 5 5 19'],
  layers: ['m12 2 9 5-9 5-9-5z', 'm3 11 9 5 9-5', 'm3 15 9 5 9-5'],
  'more-horizontal': ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  'external-link': ['M13 4h7v7', 'm20 4-9 9', 'M20 14v6H4V4h6'],
  'arrow-up-right': ['M6 18 18 6', 'M8 6h10v10']
} as const

type IconName = keyof typeof paths
withDefaults(defineProps<{ name: IconName; size?: number; strokeWidth?: number }>(), {
  size: 18,
  strokeWidth: 1.8
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    class="ui-icon"
  >
    <path v-for="(path, index) in paths[name]" :key="index" :d="path" />
  </svg>
</template>

<style scoped>
.ui-icon { display: inline-block; flex: 0 0 auto; vertical-align: -0.18em; }
</style>
