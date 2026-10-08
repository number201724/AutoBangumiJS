/**
 * SearchTorrent — 1:1 port of module/searcher/searcher.py.
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import type { RssRow } from '../database/schema';
import type { NewBangumiRow } from '../database/schema';
import { RequestContent, type TorrentData } from '../network/request-contents';
import { lazyRequire } from '../utils/lazy';
import { searchUrl } from './provider';
import { withBangumiDefaults } from '../database/repos/bangumi';

const logger = new Logger('SearchTorrent');

const SEARCH_KEY = ['group_name', 'title_raw', 'season_raw', 'subtitle', 'source', 'dpi'] as const;

// TMDB preview lookup cache, bounded (LRU-ish, oldest-evicted), keyed by
// title then parser language (the title is localized while the poster usually is not).
const POSTER_CACHE_MAX = 512;
const posterCache = new Map<string, Map<string, [string | null, string | null]>>();

/** 配置重载（tmdb_base_url 变更）后必须清空，否则继续返回旧地址的缓存。 */
export function resetCache(): void {
  posterCache.clear();
}

interface TmdbInfoLike {
  title: string;
  poster_link: string | null;
}

function tmdbParserFn() {
  return lazyRequire<{
    tmdbParser(title: string, language: string, test?: boolean): Promise<TmdbInfoLike | null>;
  }>('../parser/tmdb-parser').tmdbParser;
}

export class SearchTorrent {
  private get analyser() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RSSAnalyser } = require('../rss/analyser') as typeof import('../rss/analyser');
    return new RSSAnalyser();
  }

  async searchTorrents(rssItem: RssRow): Promise<TorrentData[]> {
    const req = new RequestContent();
    return req.getTorrents(rssItem.url);
  }

  /** Fetch localized title and poster URL from TMDB for search previews. */
  private async fetchTmdbPreview(title: string): Promise<[string | null, string | null]> {
    const language = settings.data.rss_parser.language;
    const byTitle = posterCache.get(title);
    if (byTitle && byTitle.has(language)) {
      // LRU touch
      posterCache.delete(title);
      posterCache.set(title, byTitle);
      return byTitle.get(language)!;
    }

    let localizedTitle: string | null = null;
    let posterLink: string | null = null;
    try {
      const tmdbInfo = await tmdbParserFn()(title, language, true);
      if (tmdbInfo) {
        localizedTitle = tmdbInfo.title;
        posterLink = tmdbInfo.poster_link;
      }
    } catch (e) {
      logger.debug(`Failed to fetch TMDB preview for ${title}: ${e}`);
    }

    if (!posterCache.has(title) && posterCache.size >= POSTER_CACHE_MAX) {
      const oldest = posterCache.keys().next().value;
      if (oldest !== undefined) posterCache.delete(oldest);
    }
    const entry = posterCache.get(title) ?? new Map();
    entry.set(language, [localizedTitle, posterLink]);
    posterCache.set(title, entry);
    return [localizedTitle, posterLink];
  }

  /** Streaming search: yields one compact JSON Bangumi per new result (SSE). */
  async *analyseKeyword(
    keywords: string[],
    site = 'mikan',
    limit = 100,
  ): AsyncGenerator<string> {
    const rssItem = searchUrl(site, keywords);
    const torrents = await this.searchTorrents(rssItem);
    const existList: string[] = [];
    for (const torrent of torrents) {
      if (existList.length >= limit) break;
      // 跳过逐条 Mikan 主页抓取/海报下载：交互搜索可能返回很多结果，
      // 串行抓取会让搜索迟钝；海报由 TMDB 预览（有缓存）补齐。
      // Python 无类型判别：Movie 结果同样走 special_url→去重→yield（剧场版搜索）
      const bangumi = await this.analyser.torrentToData(torrent, rssItem, false);
      if (bangumi) {
        const specialLink = SearchTorrent.specialUrl(bangumi as NewBangumiRow, site).url;
        if (!existList.includes(specialLink)) {
          bangumi.rss_link = specialLink;
          existList.push(specialLink);
          if (bangumi.official_title) {
            const [tmdbTitle, tmdbPoster] = await this.fetchTmdbPreview(bangumi.official_title);
            if (tmdbTitle) bangumi.official_title = tmdbTitle;
            if (!bangumi.poster_link && tmdbPoster) bangumi.poster_link = tmdbPoster;
          }
          // Python 输出 bangumi.dict()（模型全字段，缺省为 None/默认值）——
          // 缺省字段补齐，前端按键取值不会拿到 undefined
          yield JSON.stringify('season' in bangumi ? withBangumiDefaults(bangumi as never) : bangumi);
        }
      }
    }
  }

  /** 番剧专属搜索链接（把解析出的组/标题/季等字段组成关键词）。 */
  static specialUrl(data: Partial<NewBangumiRow>, site: string): RssRow {
    const keywords: string[] = [];
    for (const key of SEARCH_KEY) {
      const value = data[key as keyof NewBangumiRow];
      if (value) keywords.push(String(value));
    }
    return searchUrl(site, keywords);
  }

  async searchSeason(data: NewBangumiRow, site = 'mikan'): Promise<TorrentData[]> {
    const rssItem = SearchTorrent.specialUrl(data, site);
    const torrents = await this.searchTorrents(rssItem);
    return torrents.filter((t) => data.title_raw && t.name.includes(data.title_raw));
  }
}
