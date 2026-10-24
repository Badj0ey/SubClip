/**
 * Only user-facing web links may leave the Electron renderer.
 * Reject non-web schemes, embedded credentials and malformed URLs before
 * passing them to the operating system's URL handler.
 */
export function safeExternalUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 4096) return null
  const value = input.trim()
  if (!/^https?:\/\//i.test(value) || /[\r\n\u0000-\u001f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return null
    }
    return url.href
  } catch {
    return null
  }
}
