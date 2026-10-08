/**
 * TorrentManager — 1:1 port of module/manager/torrent.py
 * (bangumi rule lifecycle: delete/disable/enable/update, poster refresh,
 * calendar refresh, archive, metadata refresh, offset suggestion).
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { db as sharedDb, type Database } from '../database/facade';
import {
  normalizeSavePath,
  withBangumiDefaults,
  type BangumiRow,
  type NewBangumiRow,
} from '../database/repos/bangumi';
import { DownloadClient } from '../downloader/download-client';
import { genSavePath } from '../downloader/path';
import { buildRssRule } from '../downloader/rules';
import { lazyRequire } from '../utils/lazy';

const logger = new Logger('TorrentManager');

export interface ManagerResponse {
  status: boolean;
  status_code: number;
  msg_en: string;
  msg_zh: string;
}

function resp(
  status: boolean,
  status_code: number,
  msg_en: string,
  msg_zh: string,
): ManagerResponse {
  return { status, status_code, msg_en, msg_zh };
}

function parserModules() {
  const titleParser = lazyRequire<{
    TitleParser: {
      tmdbPosterParser(b: PosterCarrierLike): Promise<void>;
    };
  }>('../parser/title-parser');
  const tmdb = lazyRequire<{
    tmdbParser(title: string, language: string): Promise<TMDBInfoLike | null>;
  }>('../parser/tmdb-parser');
  const bgm = lazyRequire<{
    fetchBgmCalendar(): Promise<Array<unknown>>;
    matchWeekday(
      officialTitle: string,
      titleRaw: string,
      items: Array<unknown>,
    ): number | null;
  }>('../parser/bgm-calendar');
  return { titleParser, tmdb, bgm };
}

interface PosterCarrierLike {
  official_title: string;
  poster_link: string | null;
}

interface TMDBInfoLike {
  title: string;
  last_season: number;
  poster_link: string | null;
  series_status: string | null;
  season_episode_counts: Record<number, number> | null;
  getOffsetForSeason(season: number): number;
}

export class TorrentManager {
  constructor(private readonly db: Database = sharedDb) {}

  /** qB/aria2 中与该番剧 save_path 相同的种子 hash 列表（限 Bangumi 类别）。 */
  private async matchTorrentsList(data: { save_path?: string | null }): Promise<string[]> {
    return new DownloadClient().withClient(async (client) => {
      // Python: get_torrent_info(status_filter=None) —— category 保持默认 "Bangumi"，
      // 不命中 BangumiCollection 等其它类别（避免误删/误移合集种子）
      const torrents = await client.getTorrentInfo('Bangumi', null);
      const targetSavePath = normalizeSavePath(data.save_path);
      return torrents
        .filter(
          (t) =>
            normalizeSavePath((t.save_path as string) ?? '') === targetSavePath,
        )
        .map((t) => (t.hash as string) ?? (t.infohash_v1 as string) ?? '');
    });
  }

  async deleteTorrents(data: BangumiRow, _client: unknown): Promise<ManagerResponse> {
    void _client;
    const hashList = await this.matchTorrentsList(data);
    if (hashList.length) {
      const ok = await new DownloadClient().withClient((client) =>
        client.deleteTorrent(hashList),
      );
      if (!ok) {
        return resp(false, 500, `Failed to delete torrents for ${data.official_title}`, `删除 ${data.official_title} 种子失败`);
      }
      logger.log(`Delete rule and torrents for ${data.official_title}`);
      return resp(true, 200, `Delete rule and torrents for ${data.official_title}`, `删除 ${data.official_title} 规则和种子`);
    }
    return resp(false, 406, `Can't find torrents for ${data.official_title}`, `无法找到 ${data.official_title} 的种子`);
  }

  /**
   * 停用该番剧独立订阅（aggregate=False）且不再被引用的 RSS 条目（#1053）。
   * 停用而非删除；聚合订阅永不在此处停用；rss_link 可能是逗号拼接的多个
   * 链接，逐个拆分精确匹配。
   */
  private async disableOrphanSubRss(data: BangumiRow): Promise<void> {
    const urls = new Set(
      (data.rss_link ?? '')
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    );
    if (!urls.size) return;
    // 含软删除（deleted=True）的番剧：其订阅需保留以便重新启用
    const stillReferenced = new Set<string>();
    for (const b of this.db.bangumi.searchAll()) {
      for (const u of (b.rss_link ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        stillReferenced.add(u);
      }
    }
    const orphanIds: number[] = [];
    for (const url of urls) {
      if (stillReferenced.has(url)) continue;
      const rssItem = this.db.rss.searchUrl(url);
      if (rssItem && !rssItem.aggregate && rssItem.enabled) {
        orphanIds.push(rssItem.id);
        logger.log(`[Manager] Disable orphan RSS feed ${url}`);
      }
    }
    if (orphanIds.length) {
      this.db.rss.disableBatch(orphanIds);
    }
  }

  async deleteRule(id: number | string, file = false): Promise<ManagerResponse> {
    const numId = Number(id);
    const data = this.db.bangumi.searchId(numId);
    if (data) {
      // Clean up torrent records so re-adding the same anime can re-download
      this.db.torrent.deleteByBangumiId(numId);
      this.db.bangumi.deleteOne(numId);
      // 番剧删除后停用其独立订阅的孤儿 RSS；聚合订阅不受影响
      await this.disableOrphanSubRss(data);
      let torrentMessage: ManagerResponse | null = null;
      if (file) {
        // Only the file-cleanup path needs the downloader, so an unreachable
        // downloader shouldn't block a DB-only delete.
        torrentMessage = await this.deleteTorrents(data, null);
        if (torrentMessage.status_code === 500) {
          return resp(
            false,
            500,
            `Deleted rule for ${data.official_title}, but deleting its torrents failed.`,
            `已删除 ${data.official_title} 规则，但删除种子失败。`,
          );
        }
      }
      logger.log(`Delete rule for ${data.official_title}`);
      return resp(
        true,
        200,
        `Delete rule for ${data.official_title}. ${file && torrentMessage ? torrentMessage.msg_en : ''}`,
        `删除 ${data.official_title} 规则。${file && torrentMessage ? torrentMessage.msg_zh : ''}`,
      );
    }
    return resp(false, 406, `Can't find id ${id}`, `无法找到 id ${id}`);
  }

  async disableRule(id: string | number, file = false): Promise<ManagerResponse> {
    const numId = Number(id);
    const data = this.db.bangumi.searchId(numId);
    if (data) {
      data.deleted = true;
      this.db.bangumi.update(data);
      if (file) {
        return this.deleteTorrents(data, null);
      }
      logger.log(`Disable rule for ${data.official_title}`);
      return resp(true, 200, `Disable rule for ${data.official_title}`, `禁用 ${data.official_title} 规则`);
    }
    return resp(false, 406, `Can't find id ${id}`, `无法找到 id ${id}`);
  }

  async enableRule(id: string | number): Promise<ManagerResponse> {
    const numId = Number(id);
    const data = this.db.bangumi.searchId(numId);
    if (data) {
      data.deleted = false;
      this.db.bangumi.update(data);
      logger.log(`Enable rule for ${data.official_title}`);
      return resp(true, 200, `Enable rule for ${data.official_title}`, `启用 ${data.official_title} 规则`);
    }
    return resp(false, 406, `Can't find id ${id}`, `无法找到 id ${id}`);
  }

  async updateRule(bangumiId: number, data: Partial<NewBangumiRow> & { id?: number }): Promise<ManagerResponse> {
    const oldData = this.db.bangumi.searchId(bangumiId);
    if (!oldData) {
      logger.error(`Can't find data with ${bangumiId}`);
      return resp(false, 406, `Can't find data with ${bangumiId}`, `无法找到 id ${bangumiId} 的数据`);
    }
    // Move torrent
    const matchList = await this.matchTorrentsList(oldData);
    await new DownloadClient().withClient(async (client) => {
      // Python 的 BangumiUpdate 经 pydantic 把缺失字段补成模型默认值后再算
      // 新路径（对部分 PATCH 体也一样）；用 withBangumiDefaults 对齐该语义
      const withDefaults = withBangumiDefaults(data as Partial<NewBangumiRow>);
      const newPath = genSavePath(withDefaults);
      const oldPath = oldData.save_path;

      // Move existing torrents to new location if path changed
      if (matchList.length && newPath !== oldPath) {
        await client.moveTorrent(matchList, newPath);
        logger.log(`Moved torrents from ${oldPath} to ${newPath}`);
      }

      // Update qBittorrent RSS rule if save_path changed
      if (newPath !== oldPath && oldData.rule_name) {
        const rule = buildRssRule(withDefaults, newPath);
        await client.setRssRule(oldData.rule_name, rule);
        logger.log(`Updated RSS rule ${oldData.rule_name} with new save_path`);
      }

      data.save_path = newPath;
    });
    this.db.bangumi.update({ ...data, id: bangumiId });
    return resp(true, 200, `Update rule for ${data.official_title}`, `更新 ${data.official_title} 规则`);
  }

  async refreshPoster(): Promise<ManagerResponse> {
    const bangumis = this.db.bangumi.searchAll();
    const { TitleParser } = parserModules().titleParser;
    for (const b of bangumis) {
      if (!b.poster_link) {
        await TitleParser.tmdbPosterParser(b);
      }
    }
    this.db.bangumi.updateAll(bangumis);
    return resp(true, 200, 'Refresh poster link successfully.', '刷新海报链接成功。');
  }

  async refindPoster(bangumiId: number): Promise<ManagerResponse> {
    const b = this.db.bangumi.searchId(bangumiId);
    if (!b) {
      return resp(false, 406, `Can't find id ${bangumiId}`, `无法找到 id ${bangumiId}`);
    }
    const { TitleParser } = parserModules().titleParser;
    await TitleParser.tmdbPosterParser(b);
    this.db.bangumi.update(b);
    return resp(true, 200, 'Refresh poster link successfully.', '刷新海报链接成功。');
  }

  /** Fetch Bangumi.tv calendar and update air_weekday for all bangumi. */
  async refreshCalendar(): Promise<ManagerResponse> {
    const { fetchBgmCalendar, matchWeekday } = parserModules().bgm;
    const calendarItems = await fetchBgmCalendar();
    if (!calendarItems.length) {
      return resp(false, 500, 'Failed to fetch calendar data from Bangumi.tv.', '从 Bangumi.tv 获取放送表失败。');
    }
    const bangumis = this.db.bangumi.searchAll();
    let updated = 0;
    for (const b of bangumis) {
      if (b.deleted || b.weekday_locked) continue;
      const weekday = matchWeekday(b.official_title, b.title_raw, calendarItems);
      if (weekday !== null && weekday !== b.air_weekday) {
        b.air_weekday = weekday;
        updated += 1;
      }
    }
    if (updated > 0) {
      this.db.bangumi.updateAll(bangumis);
    }
    logger.log(`Calendar refresh: updated ${updated} bangumi.`);
    return resp(
      true,
      200,
      `Calendar refreshed. Updated ${updated} anime.`,
      `放送表已刷新，更新了 ${updated} 部番剧。`,
    );
  }

  async searchAllBangumi(): Promise<BangumiRow[]> {
    const datas = this.db.bangumi.searchAll();
    if (!datas.length) return [];
    return datas.filter((d) => !d.deleted);
  }

  async searchOne(id: number | string): Promise<BangumiRow | ManagerResponse> {
    const data = this.db.bangumi.searchId(Number(id));
    if (!data) {
      logger.error(`Can't find data with ${id}`);
      return resp(false, 406, `Can't find data with ${id}`, `无法找到 id ${id} 的数据`);
    }
    return data;
  }

  async archiveRule(id: number): Promise<ManagerResponse> {
    const data = this.db.bangumi.searchId(id);
    if (!data) return resp(false, 406, `Can't find id ${id}`, `无法找到 id ${id}`);
    if (this.db.bangumi.archiveOne(id)) {
      logger.log(`Archived ${data.official_title}`);
      return resp(true, 200, `Archived ${data.official_title}`, `已归档 ${data.official_title}`);
    }
    return resp(false, 500, `Failed to archive ${data.official_title}`, `归档 ${data.official_title} 失败`);
  }

  async unarchiveRule(id: number): Promise<ManagerResponse> {
    const data = this.db.bangumi.searchId(id);
    if (!data) return resp(false, 406, `Can't find id ${id}`, `无法找到 id ${id}`);
    if (this.db.bangumi.unarchiveOne(id)) {
      logger.log(`Unarchived ${data.official_title}`);
      return resp(true, 200, `Unarchived ${data.official_title}`, `已取消归档 ${data.official_title}`);
    }
    return resp(false, 500, `Failed to unarchive ${data.official_title}`, `取消归档 ${data.official_title} 失败`);
  }

  /** Refresh TMDB metadata and auto-archive ended series. */
  async refreshMetadata(): Promise<ManagerResponse> {
    const { tmdbParser } = parserModules().tmdb;
    const bangumis = this.db.bangumi.searchAll();
    const language = settings.data.rss_parser.language;
    let archivedCount = 0;
    let posterCount = 0;

    for (const b of bangumis) {
      if (b.deleted) continue;
      const tmdbInfo = await tmdbParser(b.official_title, language);
      if (tmdbInfo) {
        // Update poster if missing
        if (!b.poster_link && tmdbInfo.poster_link) {
          b.poster_link = tmdbInfo.poster_link;
          posterCount += 1;
        }
        // Auto-archive ended series
        if (tmdbInfo.series_status === 'Ended' && !b.archived) {
          b.archived = true;
          archivedCount += 1;
          logger.log(`Auto-archived ended series: ${b.official_title}`);
        }
      }
    }

    if (archivedCount > 0 || posterCount > 0) {
      this.db.bangumi.updateAll(bangumis);
    }

    logger.log(`Metadata refresh: archived ${archivedCount}, updated posters ${posterCount}`);
    return resp(
      true,
      200,
      `Metadata refreshed. Archived ${archivedCount} ended series, updated ${posterCount} posters.`,
      `已刷新元数据。归档了 ${archivedCount} 部已完结番剧，更新了 ${posterCount} 个海报。`,
    );
  }

  /** Suggest offset based on TMDB episode counts. */
  async suggestOffset(bangumiId: number): Promise<{ suggested_offset: number; reason: string }> {
    const { tmdbParser } = parserModules().tmdb;
    const data = this.db.bangumi.searchId(bangumiId);
    if (!data) {
      return { suggested_offset: 0, reason: `Bangumi id ${bangumiId} not found` };
    }

    const language = settings.data.rss_parser.language;
    const tmdbInfo = await tmdbParser(data.official_title, language);

    if (!tmdbInfo || !tmdbInfo.season_episode_counts || !Object.keys(tmdbInfo.season_episode_counts).length) {
      return { suggested_offset: 0, reason: 'Unable to fetch TMDB episode data' };
    }

    const season = data.season;
    if (season <= 1) {
      return { suggested_offset: 0, reason: 'Season 1 does not need offset' };
    }

    const offset = tmdbInfo.getOffsetForSeason(season);
    if (offset === 0) {
      return { suggested_offset: 0, reason: 'No previous seasons found' };
    }

    const counts = tmdbInfo.season_episode_counts ?? {};
    const prevSeasons: string[] = [];
    for (let s = 1; s < season; s++) {
      if (s in counts) {
        prevSeasons.push(`S${s}: ${counts[s]} eps`);
      }
    }
    return { suggested_offset: offset, reason: `Previous seasons: ${prevSeasons.join(', ')}` };
  }
}
