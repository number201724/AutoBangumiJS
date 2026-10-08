/**
 * TMDB API 客户端 —— 1:1 移植 module/parser/analyser/tmdb_parser.py。
 *
 * tv 搜索 → 动画 genre 16 过滤 → 详情 → 各季集数/air_date → 虚拟季检测 →
 * get_offset_for_season；movie 兜底；海报下载缓存 data/posters；
 * 有界缓存 512（插入序淘汰，与 Python OrderedDict 行为一致）；
 * base_url/api_key 实时读 settings.data.network，空 key 用内置 TMDB_API 常量。
 */
import { Logger } from '@nestjs/common';

import { TMDB_API } from '../config/constants';
import { settings } from '../config/settings';
import { RequestContent } from '../network/request-contents';
import { saveImage } from '../utils/cache-image';
import { LruCache } from './lru-cache';
import * as re from './tokenizer/regex';

const logger = new Logger('TMDBParser');

function tmdbUrl(): string {
  // Read live so a config change (e.g. a GFW mirror, #1042) takes effect
  // without a restart.
  return settings.data.network.tmdb_base_url.replace(/\/+$/, '');
}

function apiKey(): string {
  // 用户自配 key 优先（#975）；留空回退到内置共享 key。同样读实时值
  return settings.data.network.tmdb_api_key || TMDB_API;
}

// In-memory cache for TMDB lookups to avoid repeated API calls
const TMDB_CACHE_MAX = 512;
const tmdbCache = new LruCache<string, TMDBInfo | null>(TMDB_CACHE_MAX, false);

/** 清空 TMDB 查询缓存。配置重载（如 tmdb_base_url 变更）后必须调用，否则会
 *  继续返回旧接口地址下缓存的结果。 */
export function resetCache(): void {
  tmdbCache.clear();
}

export interface TMDBSeasonEntry {
  season: string;
  air_date: string | null;
  poster_path: string | null;
}

/** 单集播出日期（内部）：ISO 字符串 + epoch 毫秒（供日期间隔计算）。 */
interface EpisodeAirDate {
  episode_number: number;
  air_date: string;
  time: number;
}

export class TMDBInfo {
  constructor(
    readonly id: number,
    readonly title: string,
    readonly original_title: string,
    readonly season: TMDBSeasonEntry[],
    readonly last_season: number,
    readonly year: string,
    readonly poster_link: string | null = null,
    /** "Ended", "Returning Series", etc. */
    readonly series_status: string | null = null,
    /** {1: 13, 2: 12, ...} */
    readonly season_episode_counts: Record<number, number> | null = null,
    /** {1: [1, 29], ...} - episode numbers where virtual seasons start */
    readonly virtual_season_starts: Record<number, number[]> | null = null,
  ) {}

  /**
   * Calculate offset for a season (negative sum of all previous seasons' episodes).
   *
   * Used when RSS episode numbers are absolute (e.g., S02E18 should be S02E05).
   * Returns the offset to subtract from the parsed episode number.
   */
  getOffsetForSeason(season: number): number {
    if (!this.season_episode_counts || season <= 1) {
      return 0;
    }
    let total = 0;
    for (let s = 1; s < season; s += 1) {
      total += this.season_episode_counts[s] ?? 0;
    }
    return -total;
  }
}

const LANGUAGE: Record<string, string> = { zh: 'zh-CN', 'zh-tw': 'zh-TW', jp: 'ja-JP', en: 'en-US' };

export function searchUrl(e: string, key = 'zh'): string {
  const query = new URLSearchParams({
    api_key: apiKey(),
    page: '1',
    query: e,
    include_adult: 'false',
    language: LANGUAGE[key],
  });
  return `${tmdbUrl()}/3/search/tv?${query.toString()}`;
}

export function searchMovieUrl(e: string, key = 'zh'): string {
  const query = new URLSearchParams({
    api_key: apiKey(),
    page: '1',
    query: e,
    include_adult: 'false',
    language: LANGUAGE[key],
  });
  return `${tmdbUrl()}/3/search/movie?${query.toString()}`;
}

export function infoUrl(e: number, key: string): string {
  return `${tmdbUrl()}/3/tv/${e}?api_key=${apiKey()}&language=${LANGUAGE[key]}`;
}

export function seasonUrl(tvId: number, seasonNumber: number, key: string): string {
  return `${tmdbUrl()}/3/tv/${tvId}/season/${seasonNumber}?api_key=${apiKey()}&language=${LANGUAGE[key]}`;
}

interface TMDBGenre {
  id?: number;
}

interface TMDBTvInfo {
  genres?: TMDBGenre[];
  seasons?: Array<{
    name?: string | null;
    air_date?: string | null;
    poster_path?: string | null;
    season_number?: number;
    episode_count?: number;
  }>;
  status?: string | null;
  poster_path?: string | null;
  original_name?: string | null;
  name?: string | null;
  first_air_date?: string | null;
}

interface TMDBSearchResult {
  results?: Array<{ id: number }>;
}

interface TMDBMovieSearchResult {
  results?: Array<{
    id: number;
    title?: string | null;
    original_title?: string | null;
    release_date?: string | null;
    poster_path?: string | null;
  }>;
}

interface TMDBSeasonData {
  episodes?: Array<{
    episode_number?: number | null;
    air_date?: string | null;
  }>;
}

async function isAnimation(
  tvId: number,
  language: string,
  req: RequestContent,
): Promise<boolean> {
  const urlInfo = infoUrl(tvId, language);
  const typeId = await req.getJson<TMDBTvInfo>(urlInfo);
  if (typeId) {
    for (const type of typeId.genres ?? []) {
      if (type.id === 16) {
        return true;
      }
    }
  }
  return false;
}

/** ISO 日期字符串 → epoch 毫秒；非法返回 null（Python fromisoformat 的 ValueError 分支）。 */
function parseIsoDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : time;
}

/**
 * Get episode air dates for a season.
 *
 * Returns:
 *     List of {episode_number, air_date} dicts, sorted by episode number
 */
async function getSeasonEpisodeAirDates(
  tvId: number,
  seasonNumber: number,
  language: string,
  req: RequestContent,
): Promise<EpisodeAirDate[]> {
  const url = seasonUrl(tvId, seasonNumber, language);
  const seasonData = await req.getJson<TMDBSeasonData>(url);
  if (!seasonData) {
    return [];
  }

  const episodes: EpisodeAirDate[] = [];
  for (const ep of seasonData.episodes ?? []) {
    const epNum = ep.episode_number;
    const airDateStr = ep.air_date;
    if (epNum && airDateStr) {
      const time = parseIsoDate(airDateStr);
      if (time === null) {
        continue;
      }
      episodes.push({ episode_number: epNum, air_date: airDateStr, time });
    }
  }

  return episodes.sort((a, b) => a.episode_number - b.episode_number);
}

/**
 * Detect virtual season breakpoints based on air date gaps.
 *
 * When there's a gap > gap_months between consecutive episodes,
 * it indicates a "cour break" or "virtual season" boundary.
 *
 * Returns:
 *     List of episode numbers where virtual seasons START (e.g., [1, 29] means
 *     S1 starts at ep1, S2 at ep29)
 */
export function detectVirtualSeasons(
  episodes: EpisodeAirDate[],
  gapMonths = 6,
): number[] {
  if (episodes.length < 2) {
    return episodes.length > 0 ? [1] : [];
  }

  const virtualSeasonStarts = [1]; // First virtual season always starts at episode 1
  const gapDays = gapMonths * 30; // Approximate months to days

  for (let i = 1; i < episodes.length; i += 1) {
    const prevEp = episodes[i - 1];
    const currEp = episodes[i];
    const daysDiff = Math.round((currEp.time - prevEp.time) / 86_400_000);

    if (daysDiff > gapDays) {
      virtualSeasonStarts.push(currEp.episode_number);
      logger.debug(
        `Detected virtual season break: ${daysDiff} days gap between ` +
          `ep${prevEp.episode_number} and ep${currEp.episode_number}`,
      );
    }
  }

  return virtualSeasonStarts;
}

/** 本地今日日期（ISO，YYYY-MM-DD），对应 datetime.date.today()。 */
function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get the count of episodes that have actually aired for a season.
 *
 * Returns:
 *     Number of episodes that have aired (air_date <= today)
 */
async function getAiredEpisodeCount(
  tvId: number,
  seasonNumber: number,
  language: string,
  req: RequestContent,
): Promise<number> {
  const url = seasonUrl(tvId, seasonNumber, language);
  const seasonData = await req.getJson<TMDBSeasonData>(url);
  if (!seasonData) {
    return 0;
  }

  const episodes = seasonData.episodes ?? [];
  const today = todayIso();
  let airedCount = 0;

  for (const ep of episodes) {
    const airDateStr = ep.air_date;
    if (airDateStr) {
      if (parseIsoDate(airDateStr) === null) {
        // Invalid date format, skip this episode
        continue;
      }
      // ISO 日期可字典序比较（air_date <= today）
      if (airDateStr <= today) {
        airedCount += 1;
      }
    }
  }

  logger.debug(
    `Season ${seasonNumber}: ${airedCount} aired of ${episodes.length} total episodes`,
  );
  return airedCount;
}

export function getSeason(seasons: TMDBSeasonEntry[]): [number, string | null] {
  // Season 0 is named "特别篇" in zh-CN and "特別篇" in zh-TW.
  let ss = seasons.filter(
    (s) => s.air_date !== null && !s.season.includes('特别') && !s.season.includes('特別'),
  );
  if (ss.length === 0) {
    return [1, null];
  }
  ss = [...ss].sort((a, b) => (a.air_date! < b.air_date! ? 1 : a.air_date! > b.air_date! ? -1 : 0));
  for (const season of ss) {
    if (re.search(/第 \d+ 季/u, season.season) !== null) {
      const [year] = season.air_date!.split('-');
      const nowYear = new Date().getFullYear();
      if (parseInt(year, 10) <= nowYear) {
        return [parseInt(season.season.match(/\d+/u)![0], 10), season.poster_path];
      }
    }
  }
  return [ss.length, ss[ss.length - 1].poster_path];
}

/**
 * 在 search/movie 端点查询电影/剧场版。
 *
 * 电影没有季度概念，因此不复用剧集的季度/集数聚合逻辑，仅返回标题、原名、
 * 年份与海报等基本信息。
 */
async function searchMovie(
  title: string,
  language: string,
  req: RequestContent,
): Promise<TMDBInfo | null> {
  let url = searchMovieUrl(title, language);
  let contents = await req.getJson<TMDBMovieSearchResult>(url);
  let results = contents?.results ?? [];
  if (results.length === 0) {
    url = searchMovieUrl(title.replace(/ /g, ''), language);
    contents = await req.getJson<TMDBMovieSearchResult>(url);
    results = contents?.results ?? [];
  }
  if (results.length === 0) {
    return null;
  }
  const movie = results[0];
  let movieTitle = movie.title || title;
  if (language === 'zh-tw' && movie.title && movie.title === movie.original_title) {
    // Same fallback as TV: zh-TW -> zh-CN -> original title.
    const cnContents = await req.getJson<TMDBMovieSearchResult>(searchMovieUrl(title, 'zh'));
    const cnMovie = (cnContents?.results ?? []).find((m) => m.id === movie.id);
    if (cnMovie?.title && cnMovie.title !== cnMovie.original_title) {
      movieTitle = cnMovie.title;
    }
  }
  const yearNumber = (movie.release_date || '').split('-')[0];
  const posterPath = movie.poster_path;
  return new TMDBInfo(
    movie.id,
    movieTitle,
    movie.original_title || title,
    [],
    0,
    String(yearNumber),
    posterPath ? `https://image.tmdb.org/t/p/w780${posterPath}` : null,
    null,
    null,
    null,
  );
}

export async function tmdbParser(
  title: string,
  language: string,
  test = false,
  isMovie = false,
): Promise<TMDBInfo | null> {
  // `test` must be part of the key: test mode returns the raw remote poster
  // URL instead of a locally-saved one, so mixing the two would poison
  // whichever caller queries second.
  const cacheKey = `${title}:${language}:${test}:${isMovie}`;
  if (tmdbCache.has(cacheKey)) {
    return tmdbCache.get(cacheKey)!;
  }

  const req = new RequestContent();
  if (isMovie) {
    // 已知是电影/剧场版，直接查询 search/movie，跳过剧集搜索
    const result = await searchMovie(title, language, req);
    tmdbCache.set(cacheKey, result);
    return result;
  }
  let url = searchUrl(title, language);
  let contents = await req.getJson<TMDBSearchResult>(url);
  if (!contents) {
    return searchMovie(title, language, req);
  }
  let results = contents.results ?? [];
  if (results.length === 0) {
    url = searchUrl(title.replace(/ /g, ''), language);
    const contentsResp = await req.getJson<TMDBSearchResult>(url);
    if (!contentsResp) {
      return searchMovie(title, language, req);
    }
    results = contentsResp.results ?? [];
    if (results.length === 0) {
      // search/tv 无结果：回退到 search/movie (剧场版等)
      return searchMovie(title, language, req);
    }
  }
  // 判断动画
  let matchedId: number | null = null;
  for (const content of results) {
    const cid = content.id;
    if (await isAnimation(cid, language, req)) {
      matchedId = cid;
      break;
    }
  }
  if (matchedId === null) {
    // search/tv 有结果但都不是动画：回退到 search/movie (剧场版等)。
    // Don't cache the negative result permanently — a temporary
    // TMDB hiccup shouldn't poison this title for the process lifetime.
    return searchMovie(title, language, req);
  }
  const urlInfo = infoUrl(matchedId, language);
  const infoContent = await req.getJson<TMDBTvInfo>(urlInfo);
  // Python 对 info_content/seasons 为 None 不做防御（迭代 None 抛 TypeError），
  // 这里显式抛出以保持同样的失败分支。
  if (infoContent === null || infoContent.seasons === undefined) {
    throw new TypeError('TMDB tv info response is missing seasons');
  }
  const season: TMDBSeasonEntry[] = infoContent.seasons.map((s) => ({
    season: s.name ?? '',
    air_date: s.air_date ?? null,
    poster_path: s.poster_path ?? null,
  }));
  const [lastSeason, posterPathFromSeason] = getSeason(season);
  let posterPath = posterPathFromSeason;
  // Extract series status (e.g., "Ended", "Returning Series")
  const seriesStatus = infoContent.status ?? null;
  // Extract episode counts per season (exclude specials at season 0)
  // For ongoing series, we need to get actual aired episode counts
  const seasonEpisodeCounts: Record<number, number> = {};
  const virtualSeasonStarts: Record<number, number[]> = {};
  const seasonNums: Array<[number, number]> = infoContent.seasons
    .filter((s) => (s.season_number ?? 0) > 0)
    .map((s) => [s.season_number ?? 0, s.episode_count ?? 0]);
  const episodeResults = await Promise.all(
    seasonNums.map(([sn]) =>
      getSeasonEpisodeAirDates(matchedId, sn, language, req).catch((error: unknown) => error),
    ),
  );
  for (let i = 0; i < seasonNums.length; i += 1) {
    const [seasonNum, totalEps] = seasonNums[i];
    const episodes = episodeResults[i];
    if (episodes instanceof Error) {
      logger.warn(`Failed to get episodes for season ${seasonNum}: ${episodes}`);
      seasonEpisodeCounts[seasonNum] = totalEps;
      continue;
    }
    if (Array.isArray(episodes) && episodes.length > 0) {
      // Detect virtual seasons based on air date gaps
      const vsStarts = detectVirtualSeasons(episodes);
      if (vsStarts.length > 1) {
        virtualSeasonStarts[seasonNum] = vsStarts;
        logger.debug(
          `Season ${seasonNum} has virtual seasons starting at episodes: ${vsStarts}`,
        );
      }
      // Count only aired episodes
      seasonEpisodeCounts[seasonNum] = episodes.length;
    } else {
      seasonEpisodeCounts[seasonNum] = totalEps;
    }
  }
  if (posterPath === null) {
    posterPath = infoContent.poster_path ?? null;
  }
  const originalTitle = infoContent.original_name ?? null;
  let officialTitle = infoContent.name ?? null;
  if (language === 'zh-tw' && officialTitle !== null && officialTitle === originalTitle) {
    // TMDB returns the original title when there is no zh-TW translation:
    // fall back to zh-CN, and keep the original title if that is missing too.
    const cnInfo = await req.getJson<TMDBTvInfo>(infoUrl(matchedId, 'zh'));
    if (cnInfo?.name && cnInfo.name !== cnInfo.original_name) {
      officialTitle = cnInfo.name;
    }
  }
  const yearNumber = (infoContent.first_air_date || '').split('-')[0];
  let posterLink: string | null;
  if (posterPath) {
    if (!test) {
      const posterUrl = `https://image.tmdb.org/t/p/w780${posterPath}`;
      const img = await req.getContent(posterUrl);
      // img is None if the poster download failed; don't crash on it.
      posterLink = img ? await saveImage(img, 'jpg', posterUrl) : null;
    } else {
      posterLink = `https://image.tmdb.org/t/p/w780${posterPath}`;
    }
  } else {
    posterLink = null;
  }
  const result = new TMDBInfo(
    matchedId,
    officialTitle ?? '',
    originalTitle ?? '',
    season,
    lastSeason,
    String(yearNumber),
    posterLink,
    seriesStatus,
    seasonEpisodeCounts,
    Object.keys(virtualSeasonStarts).length > 0 ? virtualSeasonStarts : null,
  );
  tmdbCache.set(cacheKey, result);
  return result;
}
