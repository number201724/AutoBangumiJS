/**
 * ANi release parser — dedicated parser for the ANi feed (https://api.ani.rip/ani-torrent.xml).
 *
 * ANi titles follow a fixed layout:
 *   [ANi] <title> - <episode> [<resolution>][<source>][WEB-DL][<audio/video>][<subtitle>].torrent
 *   [ANi] <romaji/english> - <title> - <episode> [...]
 *   [ANi] <title> [特別篇] - <episode> [...]
 *   [ANi] <title> - 特別篇 [...]
 *
 * The generic parser keeps the trailing ".torrent" as an English title fragment and
 * splits titles that contain " - ", so ANi feeds get a dedicated parser and an exact
 * (not substring) matching rule.
 */
import { settings } from '../config/settings';
import { getAliasesList } from '../database/repos/bangumi';
import type { BangumiRow, NewBangumiRow } from '../database/schema';

export const ANI_PARSER = 'ani';

export interface AniRelease {
  group: string;
  // Matching key: the CJK title exactly as written by ANi (season words kept, special
  // marker removed). Different seasons of one show always differ here.
  title_raw: string;
  // Title without season / special markers, used for the TMDB lookup.
  base_title: string;
  title_romaji: string | null;
  season: number | null;
  season_raw: string | null;
  episode: number;
  is_special: boolean;
  resolution: string | null;
  source: string | null;
  subtitle: string | null;
}

const ANI_TITLE_RE =
  /^\[ANi\]\s+(.+?)\s+-\s+(\d{1,4}(?:\.\d{1,2})?|特別篇)(?:v\d{1,2})?\s*((?:\[[^\]]*\])+)\s*(?:\.(?:torrent|mp4|mkv|ass|srt))?\s*$/iu;
const TAG_RE = /\[([^\]]*)\]/gu;
const SPECIAL_MARKER_RE = /\s*\[(?:特別篇|特别篇|OVA|OAD|SP)\]\s*/iu;
// Region note used by older (Bilibili era) ANi releases, e.g. "（仅限港澳台地区）".
const REGION_NOTE_RE = /\s*[（(](?:仅限|僅限)港澳台(?:地区|地區)?[）)]\s*/u;
const RESOLUTION_RE = /^\d{3,4}[pP]$/u;
const SUBTITLE_TAGS = new Set(['CHT', 'CHS', 'BIG5', 'GB', 'JPTC', 'JPSC']);
const IGNORED_SOURCE_TAGS = new Set(['WEB-DL', 'WEBRIP', 'WEB', 'AAC AVC', 'AAC', 'AVC', 'HEVC']);
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const ROMAN_SEASONS: Record<string, number> = {
  Ⅱ: 2, Ⅲ: 3, Ⅳ: 4, Ⅴ: 5, Ⅵ: 6, II: 2, III: 3, IV: 4, V: 5, VI: 6,
};

// Season markers, tried in order; group 1 is the number. Each pattern also gets
// stripped from the title to build base_title.
const SEASON_PATTERNS: RegExp[] = [
  /\s*第\s*([0-9０-９零一二兩两三四五六七八九十]+)\s*[季期部]\s*/u,
  /\s*Season\s*(\d{1,2})\s*/iu,
  /\s*(\d{1,2})(?:st|nd|rd|th)\s+Season\s*/iu,
  /\s*\bS(\d{1,2})\b\s*/u,
  /\s+(Ⅱ|Ⅲ|Ⅳ|Ⅴ|Ⅵ|II|III|IV|V|VI)\s*$/u,
];

/** Convert a Chinese / full-width / Roman season number to an integer. */
function seasonNumber(raw: string): number | null {
  const ascii = raw.replace(/[０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (/^\d+$/u.test(ascii)) return parseInt(ascii, 10);
  if (raw in ROMAN_SEASONS) return ROMAN_SEASONS[raw];
  // 十, 十一, 二十, 二十一 ...
  if (raw.includes('十')) {
    const [tens, ones] = raw.split('十');
    const t = tens ? CN_DIGITS[tens] : 1;
    const o = ones ? CN_DIGITS[ones] : 0;
    if (t === undefined || o === undefined) return null;
    return t * 10 + o;
  }
  return CN_DIGITS[raw] ?? null;
}

/** Find the season marker in a title; returns [season, raw marker, title without it]. */
function extractSeason(title: string): [number | null, string | null, string] {
  for (const pattern of SEASON_PATTERNS) {
    const m = pattern.exec(title);
    if (!m) continue;
    const season = seasonNumber(m[1]);
    if (season === null || season < 1) continue;
    const stripped = (title.slice(0, m.index) + ' ' + title.slice(m.index + m[0].length))
      .replace(/\s+/gu, ' ')
      .trim();
    return [season, m[0].trim(), stripped || title];
  }
  return [null, null, title];
}

// Separator between the romaji and the CJK title: " - " now, " / " in older releases.
const ROMAJI_SEPARATOR_RE = /(\s+-\s+|\s+\/\s+)/u;

/**
 * Split "<romaji> - <title>" (or the older "<romaji> / <title>") into its parts.
 * Leading segments without any CJK character are romaji; the rest is the title,
 * re-joined with its original separators, so CJK titles that contain " - "
 * themselves stay intact.
 */
function splitRomaji(body: string): [string | null, string] {
  // split() with a capturing group keeps the separators at the odd indexes.
  const pieces = body.split(ROMAJI_SEPARATOR_RE);
  const parts = pieces.filter((_, idx) => idx % 2 === 0);
  let i = 0;
  while (i < parts.length - 1 && !CJK_RE.test(parts[i])) i += 1;
  if (i === 0 || !parts.slice(i).some((p) => CJK_RE.test(p))) {
    return [null, body.trim()];
  }
  const romaji = parts.slice(0, i).map((p) => p.trim()).join(' ');
  const title = pieces.slice(i * 2).join('').trim();
  return [romaji, title];
}

/** Parse an ANi release title (feed item title or file name). Returns null if it is not ANi. */
export function parseAniTitle(raw: string): AniRelease | null {
  const m = ANI_TITLE_RE.exec(raw.trim());
  if (!m) return null;
  let body = m[1];
  const episodeToken = m[2];
  const tags = [...m[3].matchAll(TAG_RE)].map((t) => t[1].trim());

  let isSpecial = episodeToken === '特別篇';
  body = body.replace(REGION_NOTE_RE, ' ').trim();
  if (SPECIAL_MARKER_RE.test(body)) {
    isSpecial = true;
    body = body.replace(SPECIAL_MARKER_RE, ' ').trim();
  }
  const episode = isSpecial && episodeToken === '特別篇' ? 1 : parseFloat(episodeToken);

  const [romaji, title] = splitRomaji(body);
  if (!title) return null;
  let [season, seasonRaw, baseTitle] = extractSeason(title);
  if (season === null && romaji) {
    // Some shows only carry the season in the romaji part ("... S02 - 中文名").
    [season, seasonRaw] = extractSeason(romaji);
  }

  const resolution = tags.find((t) => RESOLUTION_RE.test(t)) ?? null;
  // A subtitle tag may list several codes, e.g. "CHT CHS".
  const subtitle =
    tags.find((t) => {
      const codes = t.toUpperCase().split(/[\s&/,]+/u).filter((c) => c);
      return codes.length > 0 && codes.every((c) => SUBTITLE_TAGS.has(c));
    }) ?? null;
  const source =
    tags.find(
      (t) =>
        t !== resolution && t !== subtitle && !IGNORED_SOURCE_TAGS.has(t.toUpperCase()),
    ) ?? null;

  return {
    group: 'ANi',
    title_raw: title,
    base_title: baseTitle,
    title_romaji: romaji,
    season,
    season_raw: seasonRaw,
    episode,
    is_special: isSpecial,
    resolution: resolution ? resolution.toUpperCase() : null,
    source,
    subtitle,
  };
}

/** Build a new bangumi row from an ANi release (official title is filled in later). */
export function aniToBangumi(release: AniRelease): NewBangumiRow {
  return {
    official_title: release.base_title,
    title_raw: release.title_raw,
    year: null,
    season: release.is_special ? 0 : (release.season ?? 1),
    season_raw: release.season_raw,
    group_name: release.group,
    dpi: release.resolution,
    source: release.source,
    subtitle: release.subtitle,
    eps_collect: release.episode <= 1,
    episode_offset: 0,
    filter: settings.data.rss_parser.filter.join(','),
    episode_type: release.is_special ? 'special' : 'episode',
  } as NewBangumiRow;
}

/**
 * Exact matcher for ANi torrents: the parsed title must equal the bangumi's title_raw
 * or one of its aliases, and special / regular episodes never match each other.
 * Returns undefined when the name is not an ANi title.
 */
export function matchAniBangumiInList(
  torrentName: string,
  bangumiList: BangumiRow[],
): BangumiRow | undefined {
  const release = parseAniTitle(torrentName);
  if (release === null) return undefined;
  const expectedType = release.is_special ? 'special' : 'episode';
  let best: BangumiRow | undefined;
  for (const b of bangumiList) {
    if (b.deleted || b.episode_type !== expectedType) continue;
    if (b.title_raw !== release.title_raw && !getAliasesList(b).includes(release.title_raw)) {
      continue;
    }
    // Prefer the ANi rule, then the oldest one, so results are stable.
    const isAni = b.group_name === release.group;
    const bestIsAni = best !== undefined && best.group_name === release.group;
    if (best === undefined || (isAni && !bestIsAni) || (isAni === bestIsAni && b.id < best.id)) {
      best = b;
    }
  }
  return best;
}

/** True when an RSS item is configured to use the ANi parser. */
export function isAniParser(parser: string | null | undefined): boolean {
  return parser === ANI_PARSER;
}
