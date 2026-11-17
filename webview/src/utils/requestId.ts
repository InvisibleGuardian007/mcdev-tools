/**
 * Webview → 扩展请求的唯一 id。
 * 以前每个调试页签各自复制一份，统一放这里，避免实现漂移。
 */
export function createRequestId(prefix?: string): string {
  const base = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  return prefix ? `${prefix}-${base}` : base;
}
