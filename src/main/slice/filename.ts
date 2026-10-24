/**
 * 切片备注名 → 安全文件名。
 *
 * 实现已挪到 `@shared/filename`（第五阶段起渲染进程也要用同一份规则生成名字），
 * 这里只做转发，保持历史导入路径（`./slice/filename`）继续可用。
 */
export { sanitizeFileName } from '@shared/filename'
