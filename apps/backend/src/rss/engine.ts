/**
 * RSS engine — 1:1 port of module/rss/engine.py.
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { db as sharedDb, type Database } from '../database/facade';
import {
  groupsAreSimilar,
  matchBangumiInList,
  releaseFitsBangumi,
  type BangumiRow,
} from '../database/repos/bangumi';
import type { NewTorrentRow, TorrentRow } from '../database/schema';
import { AddResult } from '../downloader/base';
import type { DownloadClient } from '../downloader/download-client';
import { RequestContent, type TorrentData } from '../network/request-contents';
import { utcNowIso } from '../utils/time';
import { lazyRequire } from '../utils/lazy';
import { compileUserRegex } from '../utils/pyregex';
import type { MediaType, ParsedRelease } from '../parser/types';

const logger = new Logger('RSSEngine');

// Delay between consecutive requests to the same host. Firing all feeds of one
// site at once gets the whole batch rate-limited with HTTP 429 (#1026).
const RSS_PER_HOST_DELAY = 2.0;

export interface EngineResponse {
  status: boolean;
  status_code: number;
  msg_en: string;
  msg_zh: string;
}

function resp(status: boolean, status_code: number, msg_en: string, msg_zh: string): EngineResponse {
  return { status, status_code, msg_en, msg_zh };
}

/** 比较分辨率是否一致（"1080p" 与 "1080" 视为相同）。 */
function resolutionMatches(candidate: string | null, preferred: string | null): boolean {
  if (!candidate || !preferred) return false;
  return candidate.trim().replace(/[pP]$/, '') === preferred.trim().replace(/[pP]$/, '');
}

/** 候选版本相对番剧发布组/分辨率偏好的匹配得分：每命中一项 +1。 */
function preferenceScore(release: ParsedRelease, b: BangumiRow): number {
  let score = 0;
  if (b.preferred_group && groupsAreSimilar(release.group, b.preferred_group)) score += 1;
  if (b.preferred_resolution && resolutionMatches(release.resolution, b.preferred_resolution)) score += 1;
  return score;
}

function parserMods() {
  const selector = lazyRequire<{
    parseConfiguredReleaseTitle(title: string): ParsedRelease | null;
  }>('../parser/selector');
  const policy = lazyRequire<{
    preferenceIdentity(r: ParsedRelease, defaultSeason: number): [MediaType, number, number] | null;
    preferenceRevision(r: ParsedRelease): number;
  }>('../parser/release-policy');
  return { ...selector, ...policy };
}

interface SystemEventLike {
  kind: string;
  [key: string]: unknown;
}

function eventsModule() {
  return lazyRequire<{
    RssFailureEvent: new (rssName: string, rssUrl: string, error: string) => SystemEventLike;
    DownloadFailureEvent: new (officialTitle: string, torrentName: string) => SystemEventLike;
  }>('../notification/events');
}

// object identity is used directly for Python's id(torrent) semantics

export class RSSEngine {
  private filterCache = new Map<string, RegExp>();

  constructor(public readonly db: Database = sharedDb) {}

  private static async getTorrents(rss: { id: number; url: string }): Promise<NewTorrentRow[]> {
    const req = new RequestContent();
    const torrents = await req.getTorrents(rss.url);
    return torrents.map((t) => ({
      name: t.name,
      url: t.url,
      homepage: t.homepage,
      downloaded: false,
      rss_id: rss.id,
    }));
  }

  async getRssTorrents(rssId: number): Promise<TorrentRow[]> {
    const rss = this.db.rss.searchId(rssId);
    if (rss) {
      return this.db.torrent.searchRss(rssId);
    }
    return [];
  }

  async addRss(
    rssLink: string,
    name: string | null = null,
    aggregate = true,
    parser = 'mikan',
  ): Promise<EngineResponse> {
    let rssName = name;
    if (!rssName) {
      const req = new RequestContent();
      rssName = await req.getRssTitle(rssLink);
      if (!rssName) {
        return resp(false, 406, 'Failed to get RSS title.', '无法获取 RSS 标题。');
      }
    }
    const added = this.db.rss.add({
      name: rssName,
      url: rssLink,
      aggregate,
      parser,
      enabled: true,
      connection_status: null,
      last_checked_at: null,
      last_error: null,
    });
    if (added) {
      return resp(true, 200, 'RSS added successfully.', 'RSS 添加成功。');
    }
    return resp(false, 406, 'RSS added failed.', 'RSS 添加失败。');
  }

  async disableList(rssIdList: number[]): Promise<EngineResponse> {
    this.db.rss.disableBatch(rssIdList);
    return resp(true, 200, 'Disable RSS successfully.', '禁用 RSS 成功。');
  }

  async enableList(rssIdList: number[]): Promise<EngineResponse> {
    this.db.rss.enableBatch(rssIdList);
    return resp(true, 200, 'Enable RSS successfully.', '启用 RSS 成功。');
  }

  async deleteList(rssIdList: number[]): Promise<EngineResponse> {
    for (const rssId of rssIdList) {
      this.db.rss.delete(rssId);
    }
    return resp(true, 200, 'Delete RSS successfully.', '删除 RSS 成功。');
  }

  async pullRss(rssItem: { id: number; url: string }): Promise<NewTorrentRow[]> {
    const torrents = await RSSEngine.getTorrents(rssItem);
    return this.db.torrent.checkNew(torrents);
  }

  private async pullRssWithStatus(
    rssItem: { id: number; url: string; name: string | null },
  ): Promise<{ torrents: NewTorrentRow[]; error: string | null }> {
    try {
      const torrents = await this.pullRss(rssItem);
      return { torrents, error: null };
    } catch (e) {
      // Python str(e)：只取消息文本（不含 "Error: " 前缀），并带 RSS 名
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`Failed to fetch RSS ${rssItem.name ?? rssItem.url}: ${msg}`);
      return { torrents: [], error: msg };
    }
  }

  private getFilterPattern(filterStr: string): RegExp {
    let pattern = this.filterCache.get(filterStr);
    if (!pattern) {
      const rawPattern = filterStr.split(',').join('|');
      try {
        // 按 Python re 语义编译（内联 flag/命名组/Unicode 类翻译）
        pattern = compileUserRegex(rawPattern, 'i');
      } catch {
        // Filter contains invalid regex chars — fall back to literal matching
        const escaped = filterStr
          .split(',')
          .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        pattern = new RegExp(escaped, 'i');
        logger.warn(`Filter '${filterStr}' contains invalid regex, using literal matching`);
      }
      this.filterCache.set(filterStr, pattern);
    }
    return pattern;
  }

  matchTorrent(
    torrent: NewTorrentRow,
    bangumiList: BangumiRow[],
    parser?: string | null,
  ): BangumiRow | undefined {
    // ANi feeds match on the exact parsed title; substring matching on title_raw
    // lets short or broken titles (e.g. ".torrent") swallow other shows.
    const ani = lazyRequire<typeof import('../parser/ani-parser')>('../parser/ani-parser');
    const matched =
      ani.isAniParser(parser) && ani.parseAniTitle(torrent.name) !== null
        ? ani.matchAniBangumiInList(torrent.name, bangumiList)
        : matchBangumiInList(torrent.name, bangumiList);
    if (matched) {
      // 只有通过排除过滤的种子才关联 bangumi_id：被过滤掉的种子不能挂在番剧
      // 名下，否则 OffsetScanner 会用用户明确排除的剧集来计算 offset 建议。
      if (matched.filter === '') {
        torrent.bangumi_id = matched.id;
        return matched;
      }
      const pattern = this.getFilterPattern(matched.filter);
      if (!pattern.test(torrent.name)) {
        torrent.bangumi_id = matched.id;
        return matched;
      }
    }
    return undefined;
  }

  /**
   * 按番剧的发布组/分辨率偏好去重：同一集只保留最匹配偏好的版本。
   * 只影响设置了 preferred_group/preferred_resolution 的番剧；未设置偏好的
   * 番剧完全不受影响。无法得到安全单集身份的候选始终保留（保守回退）。
   *
   * 返回需要跳过下载的种子对象（按对象 identity），仅本轮 refresh 内有效。
   */
  private selectPreferenceSkips(
    matched: Array<[NewTorrentRow, BangumiRow]>,
    preferenceBangumi: Map<number, BangumiRow>,
    existingDownloaded: Map<number, TorrentRow[]>,
  ): Set<NewTorrentRow> {
    const { parseConfiguredReleaseTitle, preferenceIdentity, preferenceRevision } = parserMods();
    const skip = new Set<NewTorrentRow>();

    type Key = string;
    type Rank = [number, number];
    const keyOf = (bangumiId: number, identity: [MediaType, number, number]) =>
      `${bangumiId}|${identity[0]}|${identity[1]}|${identity[2]}`;

    // 已下载版本：按完整内容身份记录当前最高 (偏好得分, 修订号)。
    const existingBest = new Map<Key, Rank>();
    for (const [bangumiId, torrents] of existingDownloaded) {
      const b = preferenceBangumi.get(bangumiId);
      if (!b) continue;
      for (const t of torrents) {
        const release = parseConfiguredReleaseTitle(t.name);
        if (release === null) continue;
        const identity = preferenceIdentity(release, b.season);
        if (identity === null) continue;
        const key = keyOf(bangumiId, identity);
        const rank: Rank = [preferenceScore(release, b), preferenceRevision(release)];
        const previous = existingBest.get(key);
        if (previous === undefined || rank[0] > previous[0] || (rank[0] === previous[0] && rank[1] > previous[1])) {
          existingBest.set(key, rank);
        }
      }
    }

    // 本批次候选：按 (bangumi_id, media_type, season, episode) 分组。
    const batchGroups = new Map<Key, Array<{ torrent: NewTorrentRow; rank: Rank }>>();
    for (const [t, b] of matched) {
      if (!preferenceBangumi.has(b.id)) continue;
      const release = parseConfiguredReleaseTitle(t.name);
      if (release === null) continue;
      const identity = preferenceIdentity(release, b.season);
      if (identity === null) continue;
      const key = keyOf(b.id, identity);
      const rank: Rank = [preferenceScore(release, b), preferenceRevision(release)];
      const group = batchGroups.get(key) ?? [];
      group.push({ torrent: t, rank });
      batchGroups.set(key, group);
    }

    for (const [key, candidates] of batchGroups) {
      let bestRank: Rank = candidates[0].rank;
      for (const c of candidates) {
        if (c.rank[0] > bestRank[0] || (c.rank[0] === bestRank[0] && c.rank[1] > bestRank[1])) {
          bestRank = c.rank;
        }
      }
      const bestTorrent = candidates.find((c) => c.rank === bestRank)!.torrent;
      const priorBest = existingBest.get(key);
      const keepBest =
        priorBest === undefined ||
        bestRank[0] > priorBest[0] ||
        (bestRank[0] === priorBest[0] && bestRank[1] > priorBest[1]);
      for (const c of candidates) {
        if (c.torrent === bestTorrent && keepBest) continue;
        skip.add(c.torrent);
      }
    }

    return skip;
  }

  /** Refresh feeds with one parser engine for the complete workflow. */
  async refreshRss(client: DownloadClient, rssId?: number): Promise<SystemEventLike[]> {
    // 一个工作流内固定解析引擎（对应 Python parser_engine_snapshot 的
    // ContextVar）：配置保存恰好落在 refresh 中间时不应半途换引擎
    const { withParserEngineSnapshot } = lazyRequire<{
      withParserEngineSnapshot<T>(fn: () => T): T;
    }>('../parser/selector');
    return withParserEngineSnapshot(() => this.refreshRssInner(client, rssId));
  }

  private async refreshRssInner(client: DownloadClient, rssId?: number): Promise<SystemEventLike[]> {
    // Get All RSS Items
    let rssItems;
    if (!rssId) {
      rssItems = this.db.rss.searchActive();
    } else {
      const rssItem = this.db.rss.searchId(rssId);
      rssItems = rssItem ? [rssItem] : [];
    }
    logger.debug(`Get ${rssItems.length} RSS items`);

    // Parallel across hosts, serial (with a delay) within one host (#1026)
    const semaphore = new Semaphore(5);
    const pullHostGroup = async (items: typeof rssItems) => {
      const groupResults: Array<{ torrents: NewTorrentRow[]; error: string | null }> = [];
      for (const [i, item] of items.entries()) {
        if (i && RSS_PER_HOST_DELAY) {
          await new Promise((r) => setTimeout(r, RSS_PER_HOST_DELAY * 1000));
        }
        await semaphore.acquire();
        try {
          groupResults.push(await this.pullRssWithStatus(item));
        } finally {
          semaphore.release();
        }
      }
      return groupResults;
    };

    const hostGroups = new Map<string, typeof rssItems>();
    for (const item of rssItems) {
      let host = '';
      try {
        host = new URL(item.url).host;
      } catch {
        host = '';
      }
      const group = hostGroups.get(host) ?? [];
      group.push(item);
      hostGroups.set(host, group);
    }
    const groupLists = [...hostGroups.values()];
    const groupedResults = await Promise.all(groupLists.map((items) => pullHostGroup(items)));
    const itemResults: Array<{
      item: (typeof rssItems)[number];
      torrents: NewTorrentRow[];
      error: string | null;
    }> = [];
    groupLists.forEach((items, gi) => {
      items.forEach((item, ii) => {
        itemResults.push({ item, ...groupedResults[gi][ii] });
      });
    });

    const now = utcNowIso();
    // Load the active bangumi list once per refresh cycle; match in memory.
    const bangumiList = this.db.bangumi.searchAll();
    const events: SystemEventLike[] = [];
    const { RssFailureEvent, DownloadFailureEvent } = eventsModule();

    // Bangumi with a release-group/resolution preference need per-episode dedup.
    const preferenceBangumi = new Map<number, BangumiRow>();
    for (const b of bangumiList) {
      if (b.preferred_group || b.preferred_resolution) preferenceBangumi.set(b.id, b);
    }
    let existingDownloaded = new Map<number, TorrentRow[]>();
    if (preferenceBangumi.size) {
      existingDownloaded = this.db.torrent.searchDownloadedByBangumiIds([...preferenceBangumi.keys()]);
    }

    // First pass: match every torrent (tags torrent.bangumi_id as a side
    // effect) without downloading, so preference dedup sees the whole batch.
    const itemMatches = itemResults.map(({ item, torrents, error }) => ({
      rssItem: item,
      newTorrents: torrents,
      error,
      matches: torrents.map((t) => this.matchTorrent(t, bangumiList, item.parser)),
    }));

    const matchedPairs: Array<[NewTorrentRow, BangumiRow]> = [];
    for (const m of itemMatches) {
      m.newTorrents.forEach((t, i) => {
        const matched = m.matches[i];
        if (matched !== undefined) matchedPairs.push([t, matched]);
      });
    }
    const skipSet = this.selectPreferenceSkips(matchedPairs, preferenceBangumi, existingDownloaded);

    // Process results sequentially (DB operations)
    // Python 语义：本轮所有 connection_status/torrent 写入暂存在 session 里，
    // 循环结束一次 commit()；中途异常整体回滚。这里用写事务对齐
    return this.db.inWriteTransactionAsync(async () => {
      for (const { rssItem, newTorrents, error, matches } of itemMatches) {
      // Update connection status. Only notify on the working->error transition.
      const previousStatus = rssItem.connection_status;
      this.db.rss.update(rssItem.id, {
        connection_status: error ? 'error' : 'healthy',
        last_checked_at: now,
        last_error: error,
      } as never);
      if (error && previousStatus !== 'error') {
        events.push(new RssFailureEvent(rssItem.name ?? rssItem.url, rssItem.url, error));
      }
      const failedTorrents = new Set<NewTorrentRow>();
      for (const [i, torrent] of newTorrents.entries()) {
        const matchedData = matches[i];
        if (matchedData) {
          if (skipSet.has(torrent)) {
            logger.debug(
              `Skip ${torrent.name}: worse/duplicate release for an already-downloaded episode of ${matchedData.official_title}`,
            );
            continue;
          }
          const result = await client.addTorrent(torrent, matchedData as never);
          if (result === AddResult.FAILED) {
            // 投递失败：不入库（check_new 按 URL 去重，入库就永远不会再处理），
            // 下一轮 refresh 该种子仍在源里时会重新匹配并重试；同时发出失败通知。
            failedTorrents.add(torrent);
            events.push(new DownloadFailureEvent(matchedData.official_title, torrent.name));
          } else {
            // ADDED 与 DUPLICATE 都视为成功，不再对健康的重复种子发失败通知。
            logger.debug(`Add torrent ${torrent.name} to client (${result})`);
            torrent.downloaded = true;
            // Python 语义：add_torrent 里 gen_save_path 对 matched_data 的写入随
            // session commit 落库；这里显式持久化 save_path
            if (matchedData.save_path) {
              this.db.bangumi.update({ id: matchedData.id, save_path: matchedData.save_path });
            }
          }
        }
      }
      // Add all torrents to database (投递失败的除外，留待重试)
      let toPersist = newTorrents.filter((t) => !failedTorrents.has(t));
      if (!settings.data.bangumi_manage.track_orphans) {
        // 不记录未匹配种子：它们每轮会被 check_new 重新看到并在内存中重新匹配
        toPersist = toPersist.filter((t) => t.bangumi_id !== null && t.bangumi_id !== undefined);
      }
      if (toPersist.length) {
        this.db.torrent.addAll(toPersist);
      }
      }
      return events;
    });
  }

  async downloadMovie(movie: {
    id: number;
    official_title: string;
    rss_link: string | null;
    filter: string;
  }): Promise<EngineResponse> {
    if (!movie.rss_link) {
      return resp(false, 406, `Download movie ${movie.official_title} failed: no RSS link.`, `下载剧场版 ${movie.official_title} 失败：缺少 RSS 链接。`);
    }
    const req = new RequestContent();
    const filterPattern = movie.filter ? movie.filter.split(',').join('|') : '';
    const torrents: TorrentData[] = await req.getTorrents(movie.rss_link, filterPattern);
    if (!torrents.length) {
      return resp(false, 406, `[Engine] Download movie ${movie.official_title} failed.`, `下载剧场版 ${movie.official_title} 失败。`);
    }
    const { DownloadClient } = lazyRequire<typeof import('../downloader/download-client')>(
      '../downloader/download-client',
    );
    return new DownloadClient().withClient(async (client) => {
      const result = await client.addTorrent(torrents as never, movie as never);
      if (result === AddResult.FAILED) {
        return resp(false, 502, `Download movie ${movie.official_title} failed.`, `下载剧场版 ${movie.official_title} 失败。`);
      }
      const rows: NewTorrentRow[] = torrents.map((t) => ({ ...t, downloaded: true }));
      this.db.torrent.addAll(rows);
      return resp(true, 200, `Download movie ${movie.official_title} successfully.`, `下载剧场版 ${movie.official_title} 成功。`);
    });
  }

  async downloadBangumi(bangumi: BangumiRow): Promise<EngineResponse> {
    const req = new RequestContent();
    let torrents = await req.getTorrents(bangumi.rss_link, bangumi.filter.split(',').join('|'));
    torrents = torrents.filter((t) => releaseFitsBangumi(t.name, bangumi));
    if (!torrents.length) {
      return resp(false, 406, `Download ${bangumi.official_title} failed.`, `下载 ${bangumi.official_title} 失败。`);
    }
    const { DownloadClient } = lazyRequire<typeof import('../downloader/download-client')>(
      '../downloader/download-client',
    );
    return new DownloadClient().withClient(async (client) => {
      const result = await client.addTorrent(torrents as never, bangumi as never);
      if (result === AddResult.FAILED) {
        return resp(false, 502, `Download ${bangumi.official_title} failed.`, `下载 ${bangumi.official_title} 失败。`);
      }
      const rows: NewTorrentRow[] = torrents.map((t) => ({
        ...t,
        downloaded: true,
        bangumi_id: bangumi.id,
      }));
      this.db.torrent.addAll(rows);
      // addTorrent 里 gen_save_path 的写入持久化（Python session commit 语义）
      if (bangumi.save_path) {
        this.db.bangumi.update({ id: bangumi.id, save_path: bangumi.save_path });
      }
      return resp(true, 200, `Download ${bangumi.official_title} successfully.`, `下载 ${bangumi.official_title} 成功。`);
    });
  }
}

/** Minimal counting semaphore (asyncio.Semaphore equivalent). */
class Semaphore {
  private queue: Array<() => void> = [];
  private count: number;

  constructor(max: number) {
    this.count = max;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count += 1;
    }
  }
}
