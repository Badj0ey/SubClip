import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles.css'
import { resetStoreCache } from './store'

/**
 * Pinia 必须在挂载前装好。
 *
 * 状态都收在 `src/renderer/src/stores/`（第一阶段拆分），
 * `store.ts` 只作为兼容门面转发，所以这里的顺序不能颠倒：
 * 1. `createPinia()` + `app.use()` 注册实例；
 * 2. `resetStoreCache()` 清掉门面可能缓存的旧 store 引用；
 * 3. `mount()` —— 此时组件里的 `useXxxStore()` 才能拿到实例。
 */
const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
resetStoreCache()
app.mount('#app')
