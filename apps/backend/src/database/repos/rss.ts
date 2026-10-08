/**
 * RSS repository — 1:1 port of module/database/rss.py.
 * Synchronous (better-sqlite3); methods mirror the async Python API.
 */
import { Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

import { getDb, getSqlite } from '../database';
import { rssitem, torrent } from '../schema';
import type { RSS } from '@ab/types';

const logger = new Logger('RSSDatabase');

export type RssRow = typeof rssitem.$inferSelect;

/** Fields accepted by update() (mirrors RSSUpdate). */
export interface RssUpdateData {
  name?: string | null;
  url?: string;
  aggregate?: boolean;
  parser?: string;
  enabled?: boolean;
}

export class RSSDatabase {
  private get db() {
    return getDb();
  }

  add(data: Omit<RssRow, 'id'> & { id?: number }): boolean {
    const existing = this.db
      .select()
      .from(rssitem)
      .where(eq(rssitem.url, data.url))
      .get();
    if (existing) {
      if (!existing.enabled) {
        // 删除番剧时孤儿 RSS 会被停用（#1053）；重新订阅同一 URL 表达了
        // 恢复更新的意图，必须重新启用，否则番剧会静默断更（#1095）。
        this.db.update(rssitem).set({ enabled: true }).where(eq(rssitem.id, existing.id)).run();
        logger.log(`Re-enabled disabled RSS Item ${data.url}.`);
        return true;
      }
      logger.debug(`RSS Item ${data.url} already exists.`);
      return false;
    }
    logger.debug(`RSS Item ${data.url} not exists, adding...`);
    const result = this.db.insert(rssitem).values(data).run();
    data.id = Number(result.lastInsertRowid);
    return true;
  }

  addAll(data: Array<Omit<RssRow, 'id'>>): void {
    if (!data.length) return;
    const urls = data.map((i) => i.url);
    const existing = new Set(
      this.db
        .select({ url: rssitem.url })
        .from(rssitem)
        .where(inArray(rssitem.url, urls))
        .all()
        .map((r) => r.url),
    );
    const newItems = data.filter((i) => !existing.has(i.url));
    if (newItems.length) {
      this.db.insert(rssitem).values(newItems).run();
      logger.debug(`Batch inserted ${newItems.length} RSS items.`);
    }
  }

  update(id: number, data: RssUpdateData): boolean {
    const existing = this.db.select().from(rssitem).where(eq(rssitem.id, id)).get();
    if (!existing) return false;
    this.db.update(rssitem).set(data).where(eq(rssitem.id, id)).run();
    return true;
  }

  enable(id: number): boolean {
    const existing = this.db.select().from(rssitem).where(eq(rssitem.id, id)).get();
    if (!existing) return false;
    this.db.update(rssitem).set({ enabled: true }).where(eq(rssitem.id, id)).run();
    return true;
  }

  enableBatch(ids: number[]): void {
    if (!ids.length) return;
    this.db.update(rssitem).set({ enabled: true }).where(inArray(rssitem.id, ids)).run();
  }

  disable(id: number): boolean {
    const existing = this.db.select().from(rssitem).where(eq(rssitem.id, id)).get();
    if (!existing) return false;
    this.db.update(rssitem).set({ enabled: false }).where(eq(rssitem.id, id)).run();
    return true;
  }

  disableBatch(ids: number[]): void {
    if (!ids.length) return;
    this.db.update(rssitem).set({ enabled: false }).where(inArray(rssitem.id, ids)).run();
  }

  searchId(id: number): RssRow | undefined {
    return this.db.select().from(rssitem).where(eq(rssitem.id, id)).get();
  }

  searchUrl(url: string): RssRow | undefined {
    // url 仅有索引而无唯一约束（去重只在 add() 里做），遗留库可能存在重复行
    return this.db.select().from(rssitem).where(eq(rssitem.url, url)).get();
  }

  searchAll(): RssRow[] {
    return this.db.select().from(rssitem).all();
  }

  searchActive(): RssRow[] {
    return this.db.select().from(rssitem).where(eq(rssitem.enabled, true)).all();
  }

  searchAggregate(): RssRow[] {
    return this.db
      .select()
      .from(rssitem)
      .where(and(eq(rssitem.aggregate, true), eq(rssitem.enabled, true)))
      .all();
  }

  delete(id: number): boolean {
    try {
      // 先删除引用该 RSS 的 torrent，避免外键约束报错（整体原子性对齐 session commit）
      getSqlite().transaction(() => {
        this.db.delete(torrent).where(eq(torrent.rss_id, id)).run();
        this.db.delete(rssitem).where(eq(rssitem.id, id)).run();
      })();
      return true;
    } catch (e) {
      logger.error(`Delete RSS Item failed. Because: ${e}`);
      return false;
    }
  }

  deleteAll(): void {
    try {
      // 先删除所有引用 RSS 的 torrent，避免外键约束报错
      getSqlite().transaction(() => {
        this.db.delete(torrent).where(isNotNull(torrent.rss_id)).run();
        this.db.delete(rssitem).run();
      })();
    } catch (e) {
      logger.error(`Delete all RSS Items failed. Because: ${e}`);
    }
  }
}

export type { RSS };
