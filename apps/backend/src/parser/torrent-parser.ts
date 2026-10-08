/**
 * 文件名集数解析 —— 1:1 移植 module/parser/analyser/torrent_parser.py。
 * 5 条正则 + 字幕语言识别 + LRU 缓存（512）。
 */
import * as path from 'node:path';
import { Logger } from '@nestjs/common';

import { LruCache } from './lru-cache';
import * as re from './tokenizer/regex';
import type { EpisodeFile, SubtitleFile } from './types';

const logger = new Logger('TorrentParser');

// LRU cache for torrent_parser results to avoid repeated regex parsing
const PARSER_CACHE_MAX_SIZE = 512;
const parserCache = new LruCache<string, EpisodeFile | SubtitleFile | null>(
  PARSER_CACHE_MAX_SIZE,
);

const RULES = [
  String.raw`(.*) - (\d{1,4}(?:\.\d{1,2})?(?!\d|p))(?:v\d{1,2})?(?: )?(?:END)?(.*)`,
  String.raw`(.*)[\[ E](\d{1,4}(?:\.\d{1,2})?)(?:v\d{1,2})?(?: )?(?:END)?[\] ](.*)`,
  String.raw`(.*)\[(?:第)?(\d{1,4}(?:\.\d{1,2})?)[话集話](?:END)?\](.*)`,
  String.raw`(.*)第?(\d{1,4}(?:\.\d{1,2})?)[话話集](?:END)?(.*)`,
  String.raw`(.*)(?:S\d{2})?EP?(\d{1,4}(?:\.\d{1,2})?)(.*)`,
];

const COMPILED_RULES = RULES.map((rule) => new RegExp(rule, 'iu'));

// ANi names a lone special "[ANi] <title> - 特別篇 [...]" with no number at all;
// treat it as episode 1. Group 1 is "[ANi] <title>", group 2 the episode.
const ANI_LONE_SPECIAL_RULE = /^(\[ANi\] .*) - 特別篇()(?: |\[)/u;

const SUBTITLE_LANG: Record<string, string[]> = {
  'zh-tw': ['tc', 'cht', '繁', 'zh-tw'],
  zh: ['sc', 'chs', '简', 'zh'],
};

/**
 * Returns the basename of a path string.
 */
export function getPathBasename(torrentPath: string): string {
  return path.basename(torrentPath);
}

const GROUP_SPLIT_RE = /[\[\]()【】（）]/u;

export function getGroup(groupAndTitle: string): [string | null, string] {
  const n = groupAndTitle.split(GROUP_SPLIT_RE).filter((x) => x);
  if (n.length > 1) {
    if (re.matchStart(/\d+/u, n[1])) {
      return [null, groupAndTitle];
    }
    return [n[0], n[1]];
  }
  return [null, n[0]];
}

const SEASON_STRIP_RE = /([Ss]|Season )\d{1,3}/u;
const SEASON_SEARCH_RE = /([Ss]|Season )(\d{1,3})/iu;

export function getSeasonAndTitle(seasonAndTitle: string): [string, number] {
  const title = re.sub(SEASON_STRIP_RE, '', seasonAndTitle).trim();
  const match = re.search(SEASON_SEARCH_RE, seasonAndTitle);
  const season = match !== null ? parseInt(re.group(match, 2)!, 10) : 1;
  return [title, season];
}

export function getSubtitleLang(subtitleName: string): string | null {
  const lower = subtitleName.toLowerCase();
  for (const [key, value] of Object.entries(SUBTITLE_LANG)) {
    for (const v of value) {
      if (lower.includes(v)) {
        return key;
      }
    }
  }
  return null;
}

// 电影文件名通常没有集数标记，用于剥离方括号标签（分辨率/来源/字幕组等），
// 剩余文本视为标题
const BRACKET_RE = /[\[\(（【].*?[\]\)）】]/u;

/** pydantic 的 int|float 强转："01" → 1，"48.5" → 48.5。 */
function coerceEpisode(value: string): number {
  return Number(value);
}

/** Python str.strip(chars)：去掉两端指定字符集（集合语义，非范围）。 */
function stripChars(text: string, chars: string): string {
  const escaped = [...chars]
    .map((c) => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'))
    .join('');
  return text.replace(new RegExp(`^[${escaped}]+|[${escaped}]+$`, 'gu'), '');
}

function pathStem(filePath: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * 解析电影/剧场版文件：不要求集数标记，Title (Year)/Title (Year).ext 布局
 * 下文件名本身即完整标题。
 */
function parseMovieFile(
  torrentPath: string,
  torrentName: string | null,
  fileType: string,
): EpisodeFile | SubtitleFile | null {
  const mediaPath = getPathBasename(torrentPath);
  const matchName = torrentName ?? mediaPath;
  const [group] = getGroup(matchName);
  const stem = pathStem(matchName);
  let title = re.sub(BRACKET_RE, ' ', stem);
  title = stripChars(re.sub(/\s+/u, ' ', title), ' -/');
  if (!title) {
    title = pathStem(mediaPath);
  }
  const suffix = path.extname(torrentPath);
  if (fileType === 'media') {
    return {
      media_path: torrentPath,
      group,
      title,
      season: 1,
      episode: 1,
      suffix,
      episode_type: 'movie',
    };
  }
  if (fileType === 'subtitle') {
    const language = getSubtitleLang(mediaPath);
    return {
      media_path: torrentPath,
      group,
      title,
      season: 1,
      episode: 1,
      // `language` 可能为 null（未识别的字幕代码）；SubtitleFile 必填，
      // Python 此处故意让 pydantic 抛 ValidationError，TS 同样抛错。
      language: requireLanguage(language),
      suffix,
      episode_type: 'movie',
    };
  }
  return null;
}

function requireLanguage(language: string | null): string {
  if (language === null) {
    throw new TypeError('SubtitleFile.language: unrecognized subtitle code');
  }
  return language;
}

export function torrentParser(
  torrentPath: string,
  torrentName: string | null = null,
  season: number | null = null,
  fileType: string = 'media',
  episodeType: string = 'episode',
): EpisodeFile | SubtitleFile | null {
  // Check cache first to avoid repeated regex parsing
  const cacheKey = JSON.stringify([torrentPath, torrentName, season, fileType, episodeType]);
  if (parserCache.has(cacheKey)) {
    // LruCache.get 会把命中项移到最新（Python 的 move_to_end）
    return parserCache.get(cacheKey)!;
  }

  const result = torrentParserImpl(torrentPath, torrentName, season, fileType, episodeType);

  // Store in cache with LRU eviction
  parserCache.set(cacheKey, result);

  return result;
}

/** Internal implementation of torrent_parser without caching. */
function torrentParserImpl(
  torrentPath: string,
  torrentName: string | null = null,
  season: number | null = null,
  fileType: string = 'media',
  episodeType: string = 'episode',
): EpisodeFile | SubtitleFile | null {
  if (episodeType === 'movie') {
    return parseMovieFile(torrentPath, torrentName, fileType);
  }
  // Python re \d 是 Unicode 感知且 int("１２")==12——与 tokenizer 归一化同理，
  // 全角数字先映射为 ASCII（本模块不经过 normalization.ts）
  const toAsciiDigits = (s: string) =>
    s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const mediaPath = toAsciiDigits(getPathBasename(torrentPath));
  const torrentNameAscii = torrentName !== null ? toAsciiDigits(torrentName) : null;
  const matchNames = torrentNameAscii !== null ? [torrentNameAscii, mediaPath] : [mediaPath];
  for (const matchName of matchNames) {
    for (const compiledRule of [...COMPILED_RULES, ANI_LONE_SPECIAL_RULE]) {
      const matchObj = re.matchStart(compiledRule, matchName);
      if (matchObj !== null) {
        const [group, rawTitle] = getGroup(re.group(matchObj, 1)!);
        let title: string;
        let resolvedSeason: number;
        // Season 0 is a real season (specials), only a missing season is re-parsed.
        if (season === null || season === undefined) {
          [title, resolvedSeason] = getSeasonAndTitle(rawTitle);
        } else {
          [title] = getSeasonAndTitle(rawTitle);
          resolvedSeason = season;
        }
        // regex group(2) is always the numeric episode string here (no
        // optional groups); pydantic coerces it to int/float on
        // construction (e.g. "01" -> 1, "48.5" -> 48.5). The ANi lone special
        // rule captures an empty episode, which means episode 1.
        const episodeText = re.group(matchObj, 2)!;
        const episode = coerceEpisode(episodeText === '' ? '1' : episodeText);
        const suffix = path.extname(torrentPath);
        if (fileType === 'media') {
          return {
            media_path: torrentPath,
            group,
            title,
            season: resolvedSeason,
            episode,
            suffix,
            episode_type: 'episode',
          };
        }
        if (fileType === 'subtitle') {
          // `language` may be None for an unrecognized subtitle code;
          // SubtitleFile requires it, so construction intentionally
          // raises pydantic.ValidationError in that case.
          const language = getSubtitleLang(mediaPath);
          return {
            media_path: torrentPath,
            group,
            title,
            season: resolvedSeason,
            episode,
            language: requireLanguage(language),
            suffix,
            episode_type: 'episode',
          };
        }
      }
    }
  }
  return null;
}
