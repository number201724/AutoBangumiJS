/**
 * RSS analyser — 1:1 port of module/rss/analyser.py.
 * Aggregate RSS -> new bangumi/movie discovery with official-title completion.
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import type { Database } from '../database/facade';
import { db as sharedDb } from '../database/facade';
import { matchBangumiInList } from '../database/repos/bangumi';
import type { BangumiRow, NewBangumiRow, NewMovieRow, RssRow } from '../database/schema';
import { RequestContent, type TorrentData } from '../network/request-contents';
import { lazyRequire } from '../utils/lazy';

function withSnapshot<T>(fn: () => T): T {
  return lazyRequire<{
    withParserEngineSnapshot<R>(f: () => R): R;
  }>('../parser/selector').withParserEngineSnapshot(fn);
}

const logger = new Logger('RSSAnalyser');

interface TitleParserStatics {
  rawParser(raw: string): Promise<NewBangumiRow | NewMovieRow | null>;
  mikanParser(homepage: string): Promise<[string | null, string | null]>;
  tmdbParser(
    title: string,
    season: number,
    language: string,
    episodeType?: string,
  ): Promise<[string, number, string | null, string | null]>;
}

function titleParser(): TitleParserStatics {
  return lazyRequire<{ TitleParser: TitleParserStatics }>('../parser/title-parser').TitleParser;
}

function aniParser() {
  return lazyRequire<typeof import('../parser/ani-parser')>('../parser/ani-parser');
}

/** ANi feeds use the dedicated parser; anything that is not an ANi title falls back. */
async function parseTorrentTitle(
  name: string,
  rss: RssRow,
): Promise<NewBangumiRow | NewMovieRow | null> {
  const ani = aniParser();
  if (ani.isAniParser(rss.parser)) {
    const release = ani.parseAniTitle(name);
    if (release !== null) return ani.aniToBangumi(release);
  }
  return titleParser().rawParser(name);
}

function isMovieRow(r: NewBangumiRow | NewMovieRow): r is NewMovieRow {
  // Movie 行没有 season/episode_type 字段（Python 用 isinstance(Movie) 判别）
  return !('season' in r);
}

interface EngineResponse {
  status: boolean;
  status_code: number;
  msg_en: string;
  msg_zh: string;
}

export class RSSAnalyser {
  constructor(private readonly db: Database = sharedDb) {}

  /** 电影：mikan 解析器抓主页海报，tmdb 解析器补 TMDB 官方标题。 */
  async officialTitleParserMovie(
    movie: NewMovieRow,
    rss: RssRow,
    torrent: TorrentData,
    fetchPoster = true,
  ): Promise<void> {
    const parser = titleParser();
    if (fetchPoster && rss.parser === 'mikan') {
      if (!torrent.homepage) {
        logger.warn('Mikan movie torrent has no homepage info.');
      } else {
        try {
          const [posterLink, officialTitle] = await parser.mikanParser(torrent.homepage);
          movie.poster_link = posterLink;
          if (officialTitle) movie.official_title = officialTitle;
        } catch (e) {
          // Python 只接 AttributeError（TS 侧 mikan-parser 显式抛 TypeError）；
          // 其余异常上抛击穿批量流程
          if (!(e instanceof TypeError)) throw e;
          logger.warn(`Failed to parse Mikan homepage ${torrent.homepage}: ${e}`);
        }
      }
    } else if (fetchPoster && rss.parser === 'tmdb') {
      const [tmdbTitle, , year, posterLink] = await parser.tmdbParser(
        movie.official_title,
        1,
        settings.data.rss_parser.language,
        'movie',
      );
      movie.official_title = tmdbTitle;
      if (year) {
        // Python int(year)：'20.5'/'2022x' 等脏值抛 ValueError 跳过；parseInt 会取前缀
        if (/^\d+$/.test(year)) {
          movie.year = parseInt(year, 10);
        }
      }
      movie.poster_link = posterLink;
    }
    if (movie.official_title) {
      movie.official_title = movie.official_title.replace(/[/:.\\]/g, ' ');
    }
  }

  /** 番剧：补官方标题/海报。 */
  async officialTitleParser(
    bangumi: NewBangumiRow,
    rss: RssRow,
    torrent: TorrentData,
    fetchPoster = true,
  ): Promise<void> {
    const parser = titleParser();
    if (fetchPoster && rss.parser === 'mikan') {
      if (!torrent.homepage) {
        logger.warn('Mikan torrent has no homepage info.');
      } else {
        try {
          const [posterLink, officialTitle] = await parser.mikanParser(torrent.homepage);
          bangumi.poster_link = posterLink;
          if (officialTitle) bangumi.official_title = officialTitle;
        } catch (e) {
          // Python 只接 AttributeError（TS 侧 mikan-parser 显式抛 TypeError）；
          // 其余异常上抛击穿批量流程
          if (!(e instanceof TypeError)) throw e;
          logger.warn(`Failed to parse Mikan homepage ${torrent.homepage}: ${e}`);
        }
      }
    } else if (fetchPoster && rss.parser === 'tmdb') {
      const [tmdbTitle, season, year, posterLink] = await parser.tmdbParser(
        bangumi.official_title,
        bangumi.season,
        settings.data.rss_parser.language,
        bangumi.episode_type ?? 'episode',
      );
      bangumi.official_title = tmdbTitle;
      bangumi.year = year;
      bangumi.season = season;
      bangumi.poster_link = posterLink;
    } else if (fetchPoster && aniParser().isAniParser(rss.parser)) {
      // ANi: the season written in the title wins over TMDB's latest season, and
      // specials always stay in season 0 (TMDB keeps specials in its season 0).
      const explicitSeason = bangumi.season_raw ? bangumi.season : null;
      const [tmdbTitle, season, year, posterLink] = await parser.tmdbParser(
        bangumi.official_title,
        bangumi.season,
        settings.data.rss_parser.language,
        bangumi.episode_type ?? 'episode',
      );
      bangumi.official_title = tmdbTitle;
      bangumi.year = year;
      bangumi.poster_link = posterLink;
      if (bangumi.episode_type === 'special') {
        bangumi.season = 0;
      } else {
        bangumi.season = explicitSeason ?? season;
      }
    }
    if (bangumi.official_title) {
      bangumi.official_title = bangumi.official_title.replace(/[/:.\\]/g, ' ');
    }
  }

  static async getRssTorrents(rssLink: string, fullParse = true): Promise<TorrentData[]> {
    const req = new RequestContent();
    if (fullParse) {
      return req.getTorrents(rssLink);
    }
    return req.getTorrents(rssLink, '\\d+-\\d+');
  }

  async torrentsToData(
    torrents: TorrentData[],
    rss: RssRow,
    fullParse = true,
  ): Promise<{ bangumi: NewBangumiRow[]; movies: NewMovieRow[] }> {
    const newBangumi: NewBangumiRow[] = [];
    const newMovies: NewMovieRow[] = [];
    const seenIdentities = new Set<string>();
    for (const torrent of torrents) {
      const result = await parseTorrentTitle(torrent.name, rss);
      if (result === null || !result.title_raw) continue;
      const titleRaw = result.title_raw;
      const identity = isMovieRow(result)
        ? `movie|${titleRaw}|0`
        : `${(result as NewBangumiRow).episode_type ?? 'episode'}|${titleRaw}|${(result as NewBangumiRow).season}`;
      if (seenIdentities.has(identity)) continue;
      if (isMovieRow(result)) {
        await this.officialTitleParserMovie(result, rss, torrent);
        result.rss_link = rss.url;
        seenIdentities.add(identity);
        newMovies.push(result);
        logger.log(`New movie found: ${result.official_title}`);
      } else {
        await this.officialTitleParser(result, rss, torrent);
        result.rss_link = rss.url;
        if (!fullParse) {
          return { bangumi: [result], movies: newMovies };
        }
        seenIdentities.add(identity);
        newBangumi.push(result);
        logger.log(`New bangumi found: ${result.official_title}`);
      }
    }
    return { bangumi: newBangumi, movies: newMovies };
  }

  async torrentToData(
    torrent: TorrentData,
    rss: RssRow,
    fetchPoster = true,
  ): Promise<NewBangumiRow | NewMovieRow | null> {
    const result = await parseTorrentTitle(torrent.name, rss);
    if (result) {
      if (isMovieRow(result)) {
        await this.officialTitleParserMovie(result, rss, torrent, fetchPoster);
        result.rss_link = rss.url;
      } else {
        await this.officialTitleParser(result, rss, torrent, fetchPoster);
        result.rss_link = rss.url;
      }
      return result;
    }
    return null;
  }

  async rssToData(
    rss: RssRow,
    engine: { db: Database },
    fullParse = true,
  ): Promise<NewBangumiRow[]> {
    // 一个 RSS 工作流会跨多个 await 并多次解析同一资源（Movie 匹配、
    // Bangumi 匹配、入库）。工作流内固定解析引擎（Python parser_engine_snapshot）。
    return withSnapshot(() => this.rssToDataInner(rss, engine, fullParse));
  }

  private async rssToDataInner(
    rss: RssRow,
    engine: { db: Database },
    fullParse: boolean,
  ): Promise<NewBangumiRow[]> {
    const rssTorrents = await RSSAnalyser.getRssTorrents(rss.url, fullParse);
    // Filter out already-known movies first
    const torrentsAfterMovies = this.db.movie.matchList(rssTorrents, rss.url);
    // Then filter out already-known bangumi
    const ani = aniParser();
    const torrentsToAdd = ani.isAniParser(rss.parser)
      ? this.db.bangumi.matchList(torrentsAfterMovies, rss.url, (name, list) =>
          ani.parseAniTitle(name) !== null
            ? ani.matchAniBangumiInList(name, list)
            : matchBangumiInList(name, list),
        )
      : this.db.bangumi.matchList(torrentsAfterMovies, rss.url);
    if (!torrentsToAdd.length) {
      logger.debug('No new title has been found.');
      return [];
    }
    // Parse remaining torrents
    const { bangumi: newBangumi, movies: newMovies } = await this.torrentsToData(
      torrentsToAdd,
      rss,
      fullParse,
    );
    for (const movie of newMovies) {
      this.db.movie.add(movie);
    }
    if (newBangumi.length) {
      this.db.bangumi.addAll(newBangumi);
      return newBangumi;
    }
    return [];
  }

  async linkToData(rss: RssRow): Promise<NewBangumiRow | NewMovieRow | EngineResponse> {
    const torrents = await RSSAnalyser.getRssTorrents(rss.url, false);
    if (!torrents.length) {
      return {
        status: false,
        status_code: 406,
        msg_en: 'Cannot find any torrent.',
        msg_zh: '无法找到种子。',
      };
    }
    for (const torrent of torrents) {
      const data = await this.torrentToData(torrent, rss);
      if (data) {
        return data;
      }
    }
    return {
      status: false,
      status_code: 406,
      msg_en: 'Cannot parse this link.',
      msg_zh: '无法解析此链接。',
    };
  }
}
