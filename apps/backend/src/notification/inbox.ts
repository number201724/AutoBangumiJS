/**
 * 站内通知中心的持久化 sink — 1:1 port of module/notification/inbox.py.
 *
 * ``recordEvent`` 把 SystemEvent 落库（better-sqlite3 同步单写者模型，
 * 等价于 Python 的 ``async with Database()`` session-per-operation）；
 * ``inboxRevision`` 是进程内单调递增的修订号，任何入库/已读/删除操作都会
 * bump，SSE 循环据此决定是否需要查库推送，避免每个 tick 都打一次数据库。
 * AB 为单进程部署，进程内计数即可。
 */
import { db } from '../database/facade';
import type { SystemEvent } from './events';

export const INBOX_KEEP = 500;

let revision = 1;

export function inboxRevision(): number {
  return revision;
}

export function bumpInboxRevision(): void {
  revision += 1;
}

/**
 * ``json.dumps(value, ensure_ascii=False)`` 的复刻：默认分隔符是
 * ``', '`` / ``': '``（带空格），非 ASCII 字符不转义。JSON.stringify 是
 * 紧凑分隔符，入库的 payload 字符串会与 Python 版差几个空格——前端按 JSON
 * 解析不受影响，这里保持逐字节一致。
 */
function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => pyJsonDumps(item)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${JSON.stringify(key)}: ${pyJsonDumps(item)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return 'null';
}

/** 事件入库，返回消息 id；被 once 去重跳过时返回 0。 */
export function recordEvent(event: SystemEvent): number {
  const [title, body] = event.describe();
  const message = db.inbox.upsert({
    kind: event.kind,
    severity: event.severity,
    title,
    body,
    payload: pyJsonDumps(event.payload()),
    dedup_key: event.dedupKey(),
    once: event.once,
    keep: INBOX_KEEP,
  });
  if (message === undefined) {
    return 0;
  }
  bumpInboxRevision();
  return message.id;
}
