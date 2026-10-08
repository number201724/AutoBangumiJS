/**
 * Torrent repository — 1:1 port of module/database/torrent.py.
 */
import { Logger } from '@nestjs/common';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';

import { getDb } from '../database';
import { torrent } from '../schema';

const logger = new Logger('TorrentDatabase');

export type TorrentRow = typeof torrent.$inferSelect;
export type NewTorrent = typeof torrent.$inferInsert;

export class TorrentDatabase {
  private get db() {
    return getDb();
  }

  add(data: NewTorrent): void {
    this.db.insert(torrent).values(data).run();
    logger.debug(`Insert ${data.name} in database.`);
  }

  addAll(datas: NewTorrent[]): void {
    if (!datas.length) return;
    this.db.insert(torrent).values(datas).run();
    logger.debug(`Insert ${datas.length} torrents in database.`);
  }

  update(data: TorrentRow): void {
    this.db.update(torrent).set(data).where(eq(torrent.id, data.id)).run();
    logger.debug(`Update ${data.name} in database.`);
  }

  updateAll(datas: TorrentRow[]): void {
    for (const data of datas) {
      this.db.update(torrent).set(data).where(eq(torrent.id, data.id)).run();
    }
  }

  search(id: number): TorrentRow | undefined {
    return this.db.select().from(torrent).where(eq(torrent.id, id)).get();
  }

  searchAll(): TorrentRow[] {
    return this.db.select().from(torrent).all();
  }

  searchRss(rssId: number): TorrentRow[] {
    return this.db.select().from(torrent).where(eq(torrent.rss_id, rssId)).all();
  }

  /** Filter out torrents whose URL already exists in the database. */
  checkNew(torrentsList: NewTorrent[]): NewTorrent[] {
    if (!torrentsList.length) return [];
    const urls = torrentsList.map((t) => t.url);
    const existing = new Set(
      this.db
        .select({ url: torrent.url })
        .from(torrent)
        .where(inArray(torrent.url, urls))
        .all()
        .map((r) => r.url),
    );
    return torrentsList.filter((t) => !existing.has(t.url));
  }

  searchByQbHash(qbHash: string): TorrentRow | undefined {
    return this.db.select().from(torrent).where(eq(torrent.qb_hash, qbHash)).get();
  }

  searchByQbHashes(qbHashes: string[]): TorrentRow[] {
    if (!qbHashes.length) return [];
    return this.db.select().from(torrent).where(inArray(torrent.qb_hash, qbHashes)).all();
  }

  searchByBangumiId(bangumiId: number): TorrentRow[] {
    return this.db.select().from(torrent).where(eq(torrent.bangumi_id, bangumiId)).all();
  }

  /** Batch lookup already-downloaded torrents for the given bangumi ids. */
  searchDownloadedByBangumiIds(bangumiIds: number[]): Map<number, TorrentRow[]> {
    const grouped = new Map<number, TorrentRow[]>();
    if (!bangumiIds.length) return grouped;
    const rows = this.db
      .select()
      .from(torrent)
      .where(and(inArray(torrent.bangumi_id, bangumiIds), eq(torrent.downloaded, true)))
      .all();
    for (const row of rows) {
      if (row.bangumi_id === null) continue;
      const list = grouped.get(row.bangumi_id) ?? [];
      list.push(row);
      grouped.set(row.bangumi_id, list);
    }
    return grouped;
  }

  deleteByBangumiId(bangumiId: number): number {
    const rows = this.db
      .select()
      .from(torrent)
      .where(eq(torrent.bangumi_id, bangumiId))
      .all();
    if (rows.length > 0) {
      this.db.delete(torrent).where(eq(torrent.bangumi_id, bangumiId)).run();
      logger.debug(`Deleted ${rows.length} torrent records for bangumi_id ${bangumiId}.`);
    }
    return rows.length;
  }

  /** Find all torrent records not associated with any bangumi. */
  searchOrphans(): TorrentRow[] {
    return this.db.select().from(torrent).where(isNull(torrent.bangumi_id)).all();
  }

  countOrphans(): number {
    const row = this.db
      .select({ value: count() })
      .from(torrent)
      .where(isNull(torrent.bangumi_id))
      .get();
    return row?.value ?? 0;
  }

  deleteOrphans(): number {
    const result = this.db.delete(torrent).where(isNull(torrent.bangumi_id)).run();
    if (result.changes > 0) {
      logger.debug(`Deleted ${result.changes} orphan torrents.`);
    }
    return result.changes;
  }

  deleteObj(row: TorrentRow): void {
    this.db.delete(torrent).where(eq(torrent.id, row.id)).run();
    logger.debug(`Deleted torrent ${row.id}.`);
  }

  searchByUrl(url: string): TorrentRow | undefined {
    return this.db.select().from(torrent).where(eq(torrent.url, url)).get();
  }

  updateQbHash(torrentId: number, qbHash: string): boolean {
    const existing = this.search(torrentId);
    if (!existing) return false;
    this.db.update(torrent).set({ qb_hash: qbHash }).where(eq(torrent.id, torrentId)).run();
    logger.debug(`Updated qb_hash for torrent ${torrentId}: ${qbHash}`);
    return true;
  }
}
