import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * Embedding worker 是**运行时按路径加载**的 CommonJS 文件，
 * 不在主进程的 TS 依赖图里，所以 Vite 不会处理它 —— 必须手工拷到构建产物里，
 * 并保持 `src/main/embed/worker.cjs` → `out/main/embed/worker.cjs` 的相对位置
 * （`engine.ts` 按 `__dirname/embed/worker.cjs` 找它）。
 */
function copyEmbedWorker() {
  return {
    name: 'copy-embed-worker',
    writeBundle(): void {
      const from = resolve('src/main/embed/worker.cjs')
      const to = resolve('out/main/embed/worker.cjs')
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [
      // `@huggingface/transformers` / `onnxruntime-node` 带 wasm 与二进制资源，
      // 打包器处理不了，必须保持外部依赖（运行时从 node_modules 加载）
      externalizeDepsPlugin(),
      copyEmbedWorker()
    ],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()]
  }
})
