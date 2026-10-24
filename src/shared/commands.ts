/** Keyboard command launcher: navigation and safe UI actions only. */
export const COMMANDS = [
  { id: 'home', label: '前往首页', description: '查看最近使用的素材和任务', keywords: '首页 dashboard 概览', icon: 'home', group: '导航' },
  { id: 'library', label: '查看素材库', description: '管理视频和字幕文件', keywords: '资源 工作区 视频', icon: 'library', group: '导航' },
  { id: 'search', label: '搜索字幕', description: '按关键词或语义查找字幕', keywords: '搜索 查找 全库', icon: 'search', group: '导航' },
  { id: 'clips', label: '查看片段库', description: '整理收藏的片段和发布素材', keywords: '片段 素材 推荐 模板', icon: 'scissors', group: '导航' },
  { id: 'clipjobs', label: '查看导出任务', description: '查看视频导出进度和记录', keywords: '剪辑 导出 ffmpeg 队列', icon: 'queue', group: '导航' },
  { id: 'import', label: '导入本地字幕', description: 'SRT / VTT / TXT', keywords: '导入 文件 srt', icon: 'upload', group: '操作' },
  { id: 'pull', label: '获取 B 站字幕', description: '支持视频、合集和收藏夹', keywords: 'bilibili b站 下载 字幕', icon: 'download', group: '操作' },
  { id: 'settings', label: '设置', description: '管理账号、AI 服务和文件保存位置', keywords: '配置 偏好', icon: 'settings', group: '操作' },
  { id: 'theme', label: '切换主题', description: '浅色 / 深色 / 跟随系统', keywords: '夜间 dark light', icon: 'sun', group: '操作' },
  { id: 'layout', label: '重置界面布局', description: '恢复默认的面板大小', keywords: '重置 面板 尺寸', icon: 'panel', group: '操作' }
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
