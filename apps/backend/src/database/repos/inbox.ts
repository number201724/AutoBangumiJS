/**
 * Inbox (notification center) repository — 1:1 port of module/database/inbox.py.
 */
import { and, count, desc, eq, inArray, max } from 'drizzle-orm';

import { getDb } from '../database';
import { inboxmessage } from '../schema';
import { utcNowIso } from '../../utils/time';

export const DEFAULT_KEEP = 500;

export type InboxRow = typeof inboxmessage.$inferSelect;

export interface InboxUpsert {
  kind: string;
  severity?: string;
  title?: string;
  body?: string;
  payload?: string | null;
  dedup_key?: string | null;
  once?: boolean;
  keep?: number;
}

export class InboxDatabase {
  private get db() {
    return getDb();
  }

  /**
   * 写入一条通知。
   * - once=true：同 dedup_key 的行（无论已读与否）存在则跳过，返回 undefined。
   * - 否则若存在同 dedup_key 的未读行：合并——count+1、刷新 updated_at。
   * - 其余情况插入新行，并裁剪到最近 keep 条。
   */
  upsert(opts: InboxUpsert): InboxRow | undefined {
    const {
      kind,
      severity = 'info',
      title = '',
      body = '',
      payload = null,
      dedup_key = null,
      once = false,
      keep = DEFAULT_KEEP,
    } = opts;

    if (dedup_key !== null) {
      const conditions = [eq(inboxmessage.dedup_key, dedup_key)];
      if (!once) conditions.push(eq(inboxmessage.read, false));
      const existing = this.db
        .select()
        .from(inboxmessage)
        .where(and(...conditions))
        .get();
      if (existing !== undefined) {
        if (once) return undefined;
        const updated = {
          count: existing.count + 1,
          severity,
          title,
          body,
          payload,
          updated_at: utcNowIso(),
        };
        this.db.update(inboxmessage).set(updated).where(eq(inboxmessage.id, existing.id)).run();
        return { ...existing, ...updated };
      }
    }

    const now = utcNowIso();
    const result = this.db
      .insert(inboxmessage)
      .values({
        kind,
        severity,
        title,
        body,
        payload,
        dedup_key,
        read: false,
        count: 1,
        created_at: now,
        updated_at: now,
      })
      .run();
    this.prune(keep);
    return this.db
      .select()
      .from(inboxmessage)
      .where(eq(inboxmessage.id, Number(result.lastInsertRowid)))
      .get();
  }

  list(unreadOnly = false, limit = 50, offset = 0): InboxRow[] {
    const base = this.db.select().from(inboxmessage);
    const filtered = unreadOnly ? base.where(eq(inboxmessage.read, false)) : base;
    return filtered
      .orderBy(desc(inboxmessage.updated_at), desc(inboxmessage.id))
      .limit(limit)
      .offset(offset)
      .all();
  }

  countAll(unreadOnly = false): number {
    const base = this.db.select({ value: count() }).from(inboxmessage);
    const row = (unreadOnly ? base.where(eq(inboxmessage.read, false)) : base).get();
    return row?.value ?? 0;
  }

  unreadCount(): number {
    return this.countAll(true);
  }

  latestId(): number {
    const row = this.db.select({ value: max(inboxmessage.id) }).from(inboxmessage).get();
    return row?.value ?? 0;
  }

  markRead(messageId: number): boolean {
    const existing = this.db
      .select()
      .from(inboxmessage)
      .where(eq(inboxmessage.id, messageId))
      .get();
    if (!existing) return false;
    this.db.update(inboxmessage).set({ read: true }).where(eq(inboxmessage.id, messageId)).run();
    return true;
  }

  markAllRead(): number {
    const result = this.db
      .update(inboxmessage)
      .set({ read: true })
      .where(eq(inboxmessage.read, false))
      .run();
    return result.changes;
  }

  delete(messageId: number): boolean {
    const existing = this.db
      .select()
      .from(inboxmessage)
      .where(eq(inboxmessage.id, messageId))
      .get();
    if (!existing) return false;
    this.db.delete(inboxmessage).where(eq(inboxmessage.id, messageId)).run();
    return true;
  }

  clear(): number {
    const result = this.db.delete(inboxmessage).run();
    return result.changes;
  }

  /** 删除最近 keep 条以外的旧消息，返回删除数量。 */
  prune(keep: number = DEFAULT_KEEP): number {
    const staleRows = this.db
      .select({ id: inboxmessage.id })
      .from(inboxmessage)
      .orderBy(desc(inboxmessage.updated_at), desc(inboxmessage.id))
      .offset(keep)
      .all();
    if (!staleRows.length) return 0;
    const staleIds = staleRows.map((r) => r.id);
    this.db.delete(inboxmessage).where(inArray(inboxmessage.id, staleIds)).run();
    return staleIds.length;
  }
}
