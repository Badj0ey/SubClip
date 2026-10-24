/** Keyboard command launcher: navigation and safe UI actions only. */
export const COMMANDS = [
  { id: 'home', label: '打开工作台', description: '概览与最近项目', keywords: '首页 dashboard 概览', icon: 'home', group: '导航' },
  { id: 'library', label: '打开素材库', description: '浏览视频与字幕', keywords: '资源 工作区 视频', icon: 'library', group: '导航' },
  { id: 'search', label: '打开字幕检索', description: '全文与语义检索', keywords: '搜索 查找 全库', icon: 'search', group: '导航' },
  { id: 'clips', label: '打开片段库', description: '收藏、发现与素材包', keywords: '片段 素材 推荐 模板', icon: 'scissors', group: '导航' },
  { id: 'clipjobs', label: '打开剪辑任务', description: '查看队列与导出进度', keywords: '剪辑 导出 ffmpeg 队列', icon: 'queue', group: '导航' },
  { id: 'import', label: '导入本地字幕', description: 'SRT / VTT / TXT', keywords: '导入 文件 srt', icon: 'upload', group: '操作' },
  { id: 'pull', label: '从 B 站拉取字幕', description: '视频 / 合集 / 收藏夹', keywords: 'bilibili b站 下载 字幕', icon: 'download', group: '操作' },
  { id: 'settings', label: '打开设置', description: '账号、AI、快捷键与输出目录', keywords: '配置 偏好', icon: 'settings', group: '操作' },
  { id: 'theme', label: '切换外观主题', description: '浅色 / 深色 / 跟随系统', keywords: '夜间 dark light', icon: 'sun', group: '操作' },
  { id: 'layout', label: '恢复默认布局', description: '重置面板宽度与预览高度', keywords: '重置 面板 尺寸', icon: 'panel', group: '操作' }
] as const

export type CommandId = (typeof COMMANDS)[number]['id']

export function filterCommands(query: string): Array<(typeof COMMANDS)[number]> {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return [...COMMANDS]
  return COMMANDS.filter((item) => {
    const haystack = `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}
