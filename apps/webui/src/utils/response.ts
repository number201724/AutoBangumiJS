/**
 * Extract the Chinese message from a uResponse-style body ({ msg_zh, msg_en }).
 * Falls back when the body is not in that shape (e.g. raw entities).
 */
export function msgZh(res: unknown, fallback: string): string {
  if (res && typeof res === 'object') {
    const zh = (res as { msg_zh?: unknown }).msg_zh;
    if (typeof zh === 'string' && zh.trim()) return zh;
    const en = (res as { msg_en?: unknown }).msg_en;
    if (typeof en === 'string' && en.trim()) return en;
  }
  return fallback;
}
