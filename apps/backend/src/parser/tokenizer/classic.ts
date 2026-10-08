/**
 * Generic, evidence-oriented parser for anime resource names.
 *
 * Unlike the former ordered mutation pipeline, this module never reclassifies an
 * entire title fragment because it contains one marker.  It records exact matched
 * spans, removes only those spans, and reconstructs titles from the remaining
 * text.
 *
 * （镜像 classic.py —— Classic 引擎。_consume_all 保持 Python 生成器的惰性
 * availability 语义：循环体内 consume 会影响同 pattern 后续 match 的判定。）
 */

import { normalize } from './normalization';
import * as re from './regex';
import { MediaType, ParsedRelease, ReleaseKind, makeParsedRelease } from '../types';

// Python re 的 Unicode \w 等价物（字母 + 数字 + 下划线）
const W = '\\p{L}\\p{N}_';

const _TITLE_CHAR = /[A-Za-z぀-ヿ㐀-鿿豈-﫿]/u;
const _HAN = /[㐀-䶿一-鿿豈-﫿]/u;
const _PURE_HAN = /[㐀-䶿一-鿿豈-﫿]+/u;
const _KANA = /[぀-ヿ]/u;
const _LATIN = /[A-Za-z]/u;
const _NUMERIC_TITLE = /\d{1,3}(?:\s*[\/.-]\s*\d{1,3})?/u;

const _DATE = /(?<!\d)(?:19|20)\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}(?!\d)/u;
const _YEAR = /(?<!\d)((?:18|19|20|21)\d{2})(?!\d)/u;
const _FILE_SIZE = new RegExp(`(?<![${W}])\\d+(?:\\.\\d+)?\\s*[KMGT]i?B(?![${W}])`, 'iu');
const _HASH = /(?<![0-9A-F])[0-9A-F]{8}(?![0-9A-F])/iu;

const _RANGE = new RegExp(
  `(?<![${W}.])(?:E(?:P)?\\.?\\s*)?(\\d{1,4}(?:\\.\\d+)?)\\s*` +
    `(?:-|~|～|—)\\s*(?:E(?:P)?\\.?\\s*)?(\\d{1,4}(?:\\.\\d+)?)` +
    `(?:v(\\d+))?(?![${W}.])`,
  'iu',
);
const _SEASON_EPISODE = new RegExp(
  `(?<![${W}])S(\\d{1,2})\\s*E(?:P)?\\.?\\s*(\\d{1,4}(?:\\.\\d+)?)` + `(?:v(\\d+))?(?![${W}])`,
  'iu',
);
const _SEASON_EPISODE_WORDS = new RegExp(
  `(?<![${W}])Season\\s+(\\d{1,2})\\s+(?:Episode|EP?\\.?)\\s*` +
    `(\\d{1,4}(?:\\.\\d+)?)(?:v(\\d+))?(?![${W}])`,
  'iu',
);
const _SEASON = new RegExp(`(?<![${W}])(S\\d{1,2}|Season\\s+\\d{1,2})(?![${W}])`, 'iu');
const _ORDINAL_SEASON = new RegExp(
  `(?<![${W}])(\\d{1,2})(?:st|nd|rd|th)\\s+Season(?![${W}])`,
  'iu',
);
const _CHINESE_SEASON = /第([零〇一二两三四五六七八九十百\d]+)[季期]/u;
// Unicode 罗马数字 Ⅰ-Ⅻ（U+2160-216B）作季度标记，如 "Clevatess Ⅱ"（#1108）
const _ROMAN_SEASON = /(?<![A-Za-z])[Ⅰ-Ⅻ](?![A-Za-z])/u;
const _EXPLICIT_EPISODE = new RegExp(
  `(?<![${W}])(?:Episode|EP?\\.?|#)\\s*[-_. ]?\\s*` + `(\\d{1,4}(?:\\.\\d+)?)(?:v(\\d+))?(?![${W}])`,
  'iu',
);
const _CHINESE_EPISODE = /(?:第\s*)?(\d{1,4}(?:\.\d+)?)\s*[话話集]/u;
const _FULL_COLLECTION = /全\s*(\d{1,4})\s*[话話集]/u;
const _PRE_EPISODE = /^\s*(\d{1,4})Pre\s*$/iu;
const _COMPOUND_EPISODE = /^\s*(\d{1,4})\(\d+\)\s*$/u;
const _ATLAS_EPISODE = /^\s*(\d{1,4})_(?:.*[぀-ヿ㐀-鿿].*)$/u;
const _BARE_EPISODE = /^\s*-?\s*(\d{1,4}(?:\.\d+)?)(?:v(\d+))?\s*$/iu;
const _TRAILING_EPISODE =
  /(?:\s+-\s*|(?<=[^\d\s])-\s*|\s+)(\d{1,4}(?:\.\d+)?)(?:v(\d+))?\s*$/iu;

const _SPECIAL_NUMBER =
  /(?<![A-Za-z0-9])(OVA|OAD|SP|Special)\s*(?:[-_.]\s*)?(\d{1,4}(?:\.\d+)?)(?:v(\d+))?(?![A-Za-z0-9])/iu;
const _SPECIAL_WORD = /(?<![A-Za-z0-9])(OVA|OAD|SP|Special)(?![A-Za-z0-9])/iu;
const _SPECIAL_CJK = /番外篇?|特別篇|特别篇/u;
const _PV = /(?<![A-Za-z0-9])(PV|CM)(?:\s*[-_.]?\s*(\d{1,3}))?(?![A-Za-z0-9=])/iu;
const _NCOP = /(?<![A-Za-z0-9])NCOP(?:v?(\d+))?(?![A-Za-z0-9])/iu;
const _NCED = /(?<![A-Za-z0-9])NCED(?:v?(\d+))?(?![A-Za-z0-9])/iu;
const _MOVIE_CJK = /劇場版|剧场版|電影版|电影版|(?<![㐀-鿿])(?:劇場|剧场)(?![㐀-鿿])/u;
const _MOVIE_ROMAJI = new RegExp(`(?<![${W}])Gekijou-?ban(?![${W}])`, 'iu');
const _MOVIE_EN = new RegExp(`(?<![${W}])(?:The\\s+)?Movie(?![${W}])`, 'iu');

const _BATCH = new RegExp(
  `(?<![${W}])(?:Complete(?:\\s+(?:Series|Season))?(?:\\s+Batch)?|Batch)(?![${W}])`,
  'iu',
);
const _COLLECTION = /合集|全集|全[话話集]|总集篇|總集篇|特典/u;

const _RESOLUTION =
  /(?<![A-Za-z0-9])(?:\d{3,4}[xX]\d{3,4}|(?:720|1080|2160)[pP](?:60)?|4[Kk])(?![A-Za-z0-9])/u;
const _SOURCE = new RegExp(
  `(?<![${W}])(?:WEB[-_. ]?DL(?:\\s+Remux)?|WebRip|BDRip|BluRay|Blu-Ray|` +
    String.raw`B-Global|Baha|Bilibili|AT-X|TTFC|CR|ADN|iQIYI|Abema|AMZN|NF|` +
    String.raw`HDTV|DVD|Remux|WEB)(?![${W}])`,
  'iu',
);
const _CODEC =
  /(?<![A-Za-z0-9])(?:HEVC(?:[-_. ]?10[- ]?bit)?|AVC|x26[45]|H\.?26[45]|(?:8|10|12)bit|Ma10p)(?![A-Za-z0-9])/iu;
const _AUDIO =
  /(?<![A-Za-z0-9])(?:AAC|FLAC|MP3|AC-?3|E-?AC-?3|DDP(?:\d(?:\.\d)?)?|DTS|Opus|Dual[-_ ]?Audio)(?![A-Za-z0-9])/iu;
const _CONTAINER = /(?<![A-Za-z0-9])(MP4|MKV|AVI)(?![A-Za-z0-9])/iu;
const _SUBTITLE =
  /(?<![A-Za-z0-9])(?:CHS(?:_JP)?|CHT(?:_JP)?|GB(?:_(?:JP|MP4|MKV))?|Big5|VOSTFR|ENG|Multi[-_ ]?Subs?|Multiple[-_ ]?Subtitles?|ASSx2|PGS)(?![A-Za-z0-9])/iu;
const _CJK_SUBTITLE_TAG = /[简簡繁日英中字幕体體双雙语語内內封嵌外挂掛多国國]+(?:PGS)?/iu;
const _VERSION = new RegExp(`(?<![${W}])[vV](\\d+)(?![${W}])`, 'u');
const _PREFIX = /^\s*(?:★?\s*\d{1,2}月新番\s*★?|★?\s*新番\s*★?)/u;
const _RECRUIT = /[（(]?(?:字幕社?)?招[募人].*[）)]?$|急招翻校轴|搜索用[：:].*$/u;
const _REGION = /[（(](?:仅限)?港澳台地区[）)]/u;
const _DUB = /(?:配音版|Dub)/iu;
const _TRAILING_RELEASE_GROUP = new RegExp(`\\s*-[${W}·&.-]+(?:Raws?|Subs?)\\s*$`, 'iu');

// 内联小 pattern（对应 classic.py 中的字面 re 调用）
const _GROUP_CJK = /字幕[组組社]?|搬运|搬運|压制|壓制|发布|發佈/u;
const _GROUP_LATIN = /raws?|fansub|subs?|house|studio|group|team|rip/u;
const _GROUP_TOKEN = /[A-Z0-9.-]+/u;
const _DIGITS = /\d+/u;
const _SEPARATOR_BEFORE = /\s+-\s*$/u;
const _EPISODE_TITLE_AFTER = /\s*-\s*(.+?)\s*/u;
const _COMPACT_RANGE = /\d(?:-|~|～|—)(?:E(?:P)?\.?)?\d/iu;
const _RANGE_LABEL = /(?:Episodes?|Eps?)\s*$/iu;
const _SLASH_SUFFIX = /\d+\s*\/\s*$/u;
const _LATIN_START = /^[A-Za-z]/u;
const _SUBTITLE_CONTAINER = /_(MP4|MKV)$/iu;
const _STRIP_SUBTITLE_CONTAINER = /_(?:MP4|MKV)$/iu;
const _EXPLICIT_TITLE_SPLIT = /\s+[/|]\s+/u;
const _SLASH = /\//u;
const _UNDERSCORE_SPLIT = /_(?=[A-Za-z぀-ヿ㐀-鿿])/u;
const _CJK_TO_LATIN = /(?<=[぀-ヿ㐀-鿿])\s*[-–—]\s*(?=[A-Z][A-Za-z]+\s+[A-Za-z])/u;
const _WHITESPACE = /\s+/u;
const _EDGE_DASHES = /^(?:[-–—]\s+)+|(?:\s+[-–—])+$/u;
const _EDGE_PIPES = /^[\s_|]+|[\s_|]+$/u;
const _EDGE_SLASHES = /^\/\s*|\s*\/$/u;
const _UNDERSCORES = /_+/u;
const _METADATA_STRIP = /[\s_+.,-]+/u;
const _METADATA_TAIL_STRIP = /[\s_+.,\-–—]+/u;
const _FULLWIDTH_DASH_WRAP = /^－(.+)－$/u;
const _MOSTLY_METADATA = new RegExp(`[${W}\\s+_.-]{1,48}`, 'u');

interface _Segment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly enclosure: string | null;
}

function makeSegment(
  text: string,
  start: number,
  end: number,
  enclosure: string | null = null,
): _Segment {
  return { text, start, end, enclosure };
}

class _WorkingSegment {
  readonly mask: boolean[];

  constructor(readonly segment: _Segment) {
    this.mask = new Array<boolean>(segment.text.length).fill(false);
  }

  available(match: RegExpExecArray): boolean {
    return !this.mask.slice(re.start(match), re.end(match)).some(Boolean);
  }

  consume(match: RegExpExecArray): void {
    this.mask.fill(true, re.start(match), re.end(match));
  }

  consumeSpan(start: number, end: number): void {
    this.mask.fill(true, start, end);
  }

  residual(): string {
    let result = '';
    for (let i = 0; i < this.segment.text.length; i += 1) {
      result += this.mask[i] ? ' ' : this.segment.text[i];
    }
    return result;
  }
}

class _State {
  group: string | null = null;
  season: number | null = null;
  seasonRaw: string | null = null;
  episode: number | null = null;
  episodeEnd: number | null = null;
  episodeTitle: string | null = null;
  episodePriority = -1;
  mediaType: MediaType = MediaType.UNKNOWN;
  mediaPriority = -1;
  releaseKind: ReleaseKind = ReleaseKind.SINGLE;
  resolution: string | null = null;
  source: string | null = null;
  subtitle: string | null = null;
  codecs: string[] = [];
  audio: string[] = [];
  container: string | null = null;
  version: number | null = null;
  year: number | null = null;
  tags: string[] = [];
  evidence: string[] = [];

  constructor(readonly raw: string) {}

  setEpisode(
    episode: number,
    priority: number,
    end: number | null = null,
    version: number | null = null,
  ): void {
    if (priority >= this.episodePriority) {
      this.episode = episode;
      this.episodeEnd = end;
      this.episodePriority = priority;
      if (version !== null) {
        this.version = version;
      }
    }
  }

  setMedia(mediaType: MediaType, priority: number): void {
    if (priority > this.mediaPriority) {
      this.mediaType = mediaType;
      this.mediaPriority = priority;
    }
  }
}

/** Parse a resource name without requiring an episode number. */
export function parseReleaseTitle(raw: string): ParsedRelease | null {
  if (!raw || !raw.trim()) {
    return null;
  }

  const normalized = normalize(raw);
  const segments = scanSegments(normalized);
  if (segments.length === 0) {
    return null;
  }

  const state = new _State(raw);
  const groupIndices = findGroupSegments(segments);
  if (groupIndices.size > 0) {
    state.group = [...groupIndices]
      .sort((a, b) => a - b)
      .map((index) => segments[index].text.trim())
      .join('&');
    state.evidence.push('group');
  }

  const working = segments.map((segment) => new _WorkingSegment(segment));
  for (const index of groupIndices) {
    working[index].mask.fill(true);
  }

  preclassifyMovie(working, state);
  extractNumbers(working, state);
  extractMediaAndCardinality(working, state);
  extractTechnicalMetadata(working, state);

  const [titleEn, titleZh, titleJp] = reconstructTitles(working);
  if (!(titleEn || titleZh || titleJp)) {
    return null;
  }

  if (state.mediaType === MediaType.UNKNOWN) {
    if (state.episode !== null || state.releaseKind !== ReleaseKind.SINGLE) {
      state.setMedia(MediaType.EPISODE, 0);
    }
  }

  return makeParsedRelease({
    raw,
    title_en: titleEn,
    title_zh: titleZh,
    title_jp: titleJp,
    group: state.group,
    season: state.season,
    season_raw: state.seasonRaw,
    episode: state.episode,
    episode_end: state.episodeEnd,
    episode_title: state.episodeTitle,
    media_type: state.mediaType,
    release_kind: state.releaseKind,
    resolution: state.resolution,
    source: state.source,
    subtitle: state.subtitle,
    codecs: state.codecs,
    audio: state.audio,
    container: state.container,
    version: state.version,
    year: state.year,
    tags: state.tags,
    evidence: state.evidence,
  });
}

function scanSegments(text: string): _Segment[] {
  const segments: _Segment[] = [];
  let freeStart = 0;
  let index = 0;
  const bracketPairs: Record<string, string> = { '[': ']', '(': ')' };

  const addFree = (start: number, end: number): void => {
    const content = text.slice(start, end);
    if (content.trim()) {
      segments.push(makeSegment(content, start, end));
    }
  };

  while (index < text.length) {
    const opener = text[index];
    if (!(opener in bracketPairs)) {
      index += 1;
      continue;
    }
    addFree(freeStart, index);
    const closer = bracketPairs[opener];
    let depth = 1;
    let cursor = index + 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === opener) {
        depth += 1;
      } else if (text[cursor] === closer) {
        depth -= 1;
      }
      cursor += 1;
    }
    const contentEnd = depth === 0 ? cursor - 1 : text.length;
    const content = text.slice(index + 1, contentEnd);
    if (content.trim()) {
      const enclosure = opener === '[' ? 'square' : 'round';
      segments.push(makeSegment(content, index, cursor, enclosure));
    }
    index = cursor;
    freeStart = cursor;
  }

  addFree(freeStart, text.length);
  return segments;
}

function findGroupSegments(segments: _Segment[]): Set<number> {
  if (segments.length === 0 || segments[0].enclosure !== 'square') {
    return new Set();
  }
  const first = segments[0].text.trim();
  if (looksLikeMetadata(first)) {
    return new Set();
  }

  const hasFreeTitle = segments
    .slice(1)
    .some(
      (segment) =>
        segment.enclosure === null &&
        containsTitle(segment.text) &&
        !looksLikeMetadata(segment.text),
    );
  if (!(looksLikeGroup(first) || hasFreeTitle)) {
    return new Set();
  }

  const indices = new Set<number>([0]);
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.enclosure !== 'square' || !looksLikeGroup(segment.text)) {
      break;
    }
    indices.add(index);
  }
  return indices;
}

function looksLikeGroup(text: string): boolean {
  const value = text.trim();
  const lower = value.toLowerCase();
  if (_GROUP_CJK.test(value)) return true;
  if (_GROUP_LATIN.test(lower)) return true;
  if (['ani', 'official', 'magicstar', 'doomdos', 'vcb-studio'].includes(lower)) {
    return true;
  }
  if (value.includes('&') && value.length <= 48) return true;
  return Boolean(
    value.length <= 16 && !value.includes(' ') && re.fullmatch(_GROUP_TOKEN, value),
  );
}

function looksLikeMetadata(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  const structuralPatterns = [
    _RANGE,
    _SEASON_EPISODE,
    _SEASON_EPISODE_WORDS,
    _SEASON,
    _CHINESE_SEASON,
    _FULL_COLLECTION,
    _CHINESE_EPISODE,
    _BARE_EPISODE,
    _SPECIAL_NUMBER,
    _SPECIAL_WORD,
    _SPECIAL_CJK,
    _PV,
    _NCOP,
    _NCED,
    _MOVIE_CJK,
    _MOVIE_ROMAJI,
    _MOVIE_EN,
    _BATCH,
    _COLLECTION,
    _DATE,
    _YEAR,
    _FILE_SIZE,
  ];
  if (structuralPatterns.some((pattern) => re.fullmatch(pattern, value))) {
    return true;
  }
  if (re.fullmatch(_CJK_SUBTITLE_TAG, value) || ['end', '生'].includes(value.toLowerCase())) {
    return true;
  }

  let residual = value;
  const technicalPatterns = [_RESOLUTION, _SOURCE, _CODEC, _AUDIO, _CONTAINER, _SUBTITLE];
  for (const pattern of technicalPatterns) {
    residual = re.sub(pattern, ' ', residual);
  }
  residual = re.sub(_METADATA_STRIP, '', residual);
  return !containsTitle(residual);
}

function containsTitle(text: string): boolean {
  return _TITLE_CHAR.test(text);
}

function containsTitleFragment(text: string): boolean {
  return containsTitle(text) || re.fullmatch(_NUMERIC_TITLE, text.trim()) !== null;
}

function toNumber(value: string): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.trunc(number) : number;
}

function isYearNumber(value: string): boolean {
  return /^\d+$/.test(value) && value.length === 4 && Number(value) >= 1800 && Number(value) <= 2199;
}

function* consumeAll(
  work: _WorkingSegment,
  pattern: RegExp,
): Generator<RegExpExecArray> {
  for (const match of re.iterMatches(pattern, work.segment.text)) {
    if (work.available(match)) {
      yield match;
    }
  }
}

/** Record strong movie evidence before resolving ambiguous trailing numbers. */
function preclassifyMovie(working: _WorkingSegment[], state: _State): void {
  for (const work of working) {
    for (const pattern of [_MOVIE_CJK, _MOVIE_ROMAJI]) {
      let found = false;
      for (const match of consumeAll(work, pattern)) {
        void match;
        found = true;
        break;
      }
      if (found) {
        state.setMedia(MediaType.MOVIE, 100);
        return;
      }
    }
    for (const match of consumeAll(work, _MOVIE_EN)) {
      const after = work.segment.text.slice(re.end(match)).trimStart();
      if (!_LATIN_START.test(after)) {
        state.setMedia(MediaType.MOVIE, 100);
        return;
      }
    }
  }
}

function isMetadataTail(text: string): boolean {
  let residual = text;
  for (const pattern of [
    _RESOLUTION,
    _SOURCE,
    _CODEC,
    _AUDIO,
    _CONTAINER,
    _SUBTITLE,
    _TRAILING_EPISODE,
  ]) {
    residual = re.sub(pattern, ' ', residual);
  }
  residual = re.sub(_METADATA_TAIL_STRIP, '', residual);
  return !containsTitle(residual);
}

/** Separate Emby/Plex ``Series - SxxExx - Episode title`` layouts. */
function extractEpisodeTitle(
  work: _WorkingSegment,
  match: RegExpExecArray,
  state: _State,
): void {
  const before = work.segment.text.slice(0, re.start(match));
  const separator = re.search(_SEPARATOR_BEFORE, before);
  if (separator !== null) {
    work.consumeSpan(re.start(separator), re.start(match));
  }

  const after = work.segment.text.slice(re.end(match));
  const episodeTitle = re.fullmatch(_EPISODE_TITLE_AFTER, after);
  if (episodeTitle !== null && containsTitleFragment(re.group(episodeTitle, 1)!)) {
    state.episodeTitle = cleanTitle(re.group(episodeTitle, 1)!);
    work.consumeSpan(re.end(match), work.segment.text.length);
    state.evidence.push('episode-title');
  }
}

function extractNumbers(working: _WorkingSegment[], state: _State): void {
  for (const work of working) {
    const text = work.segment.text;

    for (const match of consumeAll(work, _DATE)) {
      work.consume(match);
      state.tags.push(re.group0(match));
    }

    for (const match of consumeAll(work, _FILE_SIZE)) {
      work.consume(match);
      state.tags.push(re.group0(match));
    }

    for (const match of consumeAll(work, _YEAR)) {
      if (re.group0(match) === text.trim() || isMetadataTail(text.slice(re.end(match)))) {
        work.consume(match);
        state.year = parseInt(re.group(match, 1)!, 10);
        state.evidence.push('year');
      }
    }

    for (const match of consumeAll(work, _RANGE)) {
      const rangeStart = toNumber(re.group(match, 1)!);
      const rangeEnd = toNumber(re.group(match, 2)!);
      const prefix = text.slice(0, re.start(match));
      const suffix = text.slice(re.end(match));
      const compact = _COMPACT_RANGE.test(re.group0(match));
      const isolated = !containsTitle(prefix + suffix);
      const labelled = _RANGE_LABEL.test(prefix);
      if (
        rangeStart >= 1800 ||
        rangeEnd >= 1800 ||
        rangeStart > rangeEnd ||
        _SLASH_SUFFIX.test(prefix) ||
        !(compact || isolated || labelled)
      ) {
        continue;
      }
      work.consume(match);
      state.setEpisode(rangeStart, 85, rangeEnd, intOrNull(re.group(match, 3)));
      state.releaseKind = ReleaseKind.RANGE;
      state.evidence.push('episode-range');
    }

    for (const pattern of [_SEASON_EPISODE, _SEASON_EPISODE_WORDS]) {
      for (const match of consumeAll(work, pattern)) {
        work.consume(match);
        extractEpisodeTitle(work, match, state);
        state.season = parseInt(re.group(match, 1)!, 10);
        state.seasonRaw = re.group0(match);
        state.setEpisode(toNumber(re.group(match, 2)!), 100, null, intOrNull(re.group(match, 3)));
        state.evidence.push('season', 'episode');
      }
    }

    for (const match of consumeAll(work, _SPECIAL_NUMBER)) {
      work.consume(match);
      const mediaType = specialMedia(re.group(match, 1)!);
      state.setMedia(mediaType, 80);
      state.setEpisode(toNumber(re.group(match, 2)!), 80, null, intOrNull(re.group(match, 3)));
      state.evidence.push(mediaType, 'episode');
    }

    for (const match of consumeAll(work, _PV)) {
      if (re.group(match, 2) === null) {
        continue;
      }
      work.consume(match);
      state.setMedia(MediaType.PV, 60);
      state.setEpisode(toNumber(re.group(match, 2)!), 75);
      state.evidence.push('pv', 'episode');
    }

    for (const match of consumeAll(work, _SEASON)) {
      work.consume(match);
      const rawSeason = re.group(match, 1)!;
      const numberMatch = re.search(_DIGITS, rawSeason);
      if (numberMatch !== null) {
        state.season = parseInt(re.group0(numberMatch), 10);
        state.seasonRaw = rawSeason;
        state.evidence.push('season');
      }
    }

    for (const match of consumeAll(work, _CHINESE_SEASON)) {
      work.consume(match);
      state.season = chineseNumber(re.group(match, 1)!);
      state.seasonRaw = re.group0(match);
      state.evidence.push('season');
    }

    for (const match of consumeAll(work, _ROMAN_SEASON)) {
      work.consume(match);
      state.season = re.group0(match).codePointAt(0)! - 0x215f;
      state.seasonRaw = re.group0(match);
      state.evidence.push('season');
    }

    for (const match of consumeAll(work, _ORDINAL_SEASON)) {
      if (state.season === null) {
        work.consume(match);
        state.season = parseInt(re.group(match, 1)!, 10);
        state.seasonRaw = re.group0(match);
        state.evidence.push('season');
      }
    }

    for (const match of consumeAll(work, _FULL_COLLECTION)) {
      work.consume(match);
      state.setEpisode(1, 95, parseInt(re.group(match, 1)!, 10));
      state.releaseKind = ReleaseKind.COLLECTION;
      state.evidence.push('collection', 'episode-range');
    }

    for (const match of consumeAll(work, _EXPLICIT_EPISODE)) {
      work.consume(match);
      state.setEpisode(toNumber(re.group(match, 1)!), 90, null, intOrNull(re.group(match, 2)));
      state.evidence.push('episode');
    }

    for (const match of consumeAll(work, _CHINESE_EPISODE)) {
      work.consume(match);
      state.setEpisode(toNumber(re.group(match, 1)!), 90);
      state.evidence.push('episode');
    }

    for (const pattern of [_PRE_EPISODE, _COMPOUND_EPISODE, _ATLAS_EPISODE]) {
      const match = re.matchStart(pattern, text);
      if (match !== null && work.available(match)) {
        work.consume(match);
        state.setEpisode(toNumber(re.group(match, 1)!), 75);
        state.evidence.push('episode');
      }
    }

    const trailing = re.search(_TRAILING_EPISODE, text);
    if (
      trailing !== null &&
      work.available(trailing) &&
      !isYearNumber(re.group(trailing, 1)!) &&
      state.mediaType !== MediaType.MOVIE
    ) {
      work.consume(trailing);
      state.setEpisode(toNumber(re.group(trailing, 1)!), 70, null, intOrNull(re.group(trailing, 2)));
      state.evidence.push('episode');
    }

    const bare = re.matchStart(_BARE_EPISODE, text);
    if (
      bare !== null &&
      work.available(bare) &&
      !isYearNumber(re.group(bare, 1)!) &&
      state.mediaType !== MediaType.MOVIE
    ) {
      work.consume(bare);
      state.setEpisode(toNumber(re.group(bare, 1)!), 70, null, intOrNull(re.group(bare, 2)));
      state.evidence.push('episode');
    }
  }
}

function extractMediaAndCardinality(working: _WorkingSegment[], state: _State): void {
  for (const work of working) {
    const text = work.segment.text;

    for (const match of consumeAll(work, _MOVIE_CJK)) {
      work.consume(match);
      state.setMedia(MediaType.MOVIE, 100);
      state.evidence.push('movie');
    }
    for (const match of consumeAll(work, _MOVIE_ROMAJI)) {
      work.consume(match);
      state.setMedia(MediaType.MOVIE, 100);
      state.evidence.push('movie');
    }
    for (const match of consumeAll(work, _MOVIE_EN)) {
      const before = text.slice(0, re.start(match)).trimEnd();
      const after = text.slice(re.end(match)).trimStart();
      const markerIsEdge = !before || !after || work.segment.enclosure === 'square';
      const followedByTitleWord = _LATIN_START.test(after);
      if (followedByTitleWord) {
        continue;
      }
      if (!markerIsEdge && state.episode !== null) {
        continue;
      }
      work.consume(match);
      state.setMedia(MediaType.MOVIE, 100);
      state.evidence.push('movie');
    }

    for (const match of consumeAll(work, _SPECIAL_WORD)) {
      const after = text.slice(re.end(match)).trimStart();
      if (_LATIN_START.test(after)) {
        continue;
      }
      const mediaType = specialMedia(re.group(match, 1)!);
      work.consume(match);
      state.setMedia(mediaType, 80);
      state.evidence.push(mediaType);
    }

    for (const match of consumeAll(work, _SPECIAL_CJK)) {
      work.consume(match);
      state.setMedia(MediaType.SPECIAL, 80);
      state.evidence.push('special');
    }

    for (const match of consumeAll(work, _PV)) {
      work.consume(match);
      state.setMedia(MediaType.PV, 60);
      state.evidence.push('pv');
    }
    for (const match of consumeAll(work, _NCOP)) {
      work.consume(match);
      state.setMedia(MediaType.OPENING, 60);
      state.version = state.version || intOrNull(re.group(match, 1));
      state.evidence.push('opening');
    }
    for (const match of consumeAll(work, _NCED)) {
      work.consume(match);
      state.setMedia(MediaType.ENDING, 60);
      state.version = state.version || intOrNull(re.group(match, 1));
      state.evidence.push('ending');
    }

    for (const match of consumeAll(work, _BATCH)) {
      work.consume(match);
      state.releaseKind = ReleaseKind.BATCH;
      state.evidence.push('batch');
    }
    for (const match of consumeAll(work, _COLLECTION)) {
      work.consume(match);
      state.releaseKind = ReleaseKind.COLLECTION;
      state.evidence.push('collection');
    }
  }
}

function extractTechnicalMetadata(working: _WorkingSegment[], state: _State): void {
  for (const work of working) {
    const text = work.segment.text;

    for (const match of consumeAll(work, _RESOLUTION)) {
      work.consume(match);
      state.resolution = state.resolution || re.group0(match);
      state.evidence.push('resolution');
    }
    for (const match of consumeAll(work, _SOURCE)) {
      work.consume(match);
      state.source = state.source || re.group0(match);
      state.evidence.push('source');
    }
    for (const match of consumeAll(work, _CODEC)) {
      work.consume(match);
      appendUnique(state.codecs, re.group0(match));
    }
    for (const match of consumeAll(work, _AUDIO)) {
      work.consume(match);
      appendUnique(state.audio, re.group0(match));
    }
    for (const match of consumeAll(work, _SUBTITLE)) {
      work.consume(match);
      state.subtitle = preferSubtitle(state.subtitle, re.group0(match));
      const container = re.search(_SUBTITLE_CONTAINER, re.group0(match));
      if (container !== null) {
        state.container = state.container || re.group(container, 1);
      }
    }
    for (const match of consumeAll(work, _CONTAINER)) {
      work.consume(match);
      state.container = state.container || re.group(match, 1);
    }

    if (work.segment.enclosure === 'square') {
      const subtitleTag = cleanFragment(work.residual());
      if (re.fullmatch(_CJK_SUBTITLE_TAG, subtitleTag)) {
        work.mask.fill(true);
        state.subtitle = preferSubtitle(state.subtitle, subtitleTag);
      }
      if (_DUB.test(text)) {
        work.mask.fill(true);
        state.tags.push(text.trim());
      }
    }

    for (const match of consumeAll(work, _VERSION)) {
      work.consume(match);
      state.version = state.version || parseInt(re.group(match, 1)!, 10);
    }
    for (const pattern of [_PREFIX, _RECRUIT, _REGION, _TRAILING_RELEASE_GROUP]) {
      for (const match of consumeAll(work, pattern)) {
        work.consume(match);
        state.tags.push(re.group0(match).trim());
      }
    }
    for (const match of consumeAll(work, _HASH)) {
      work.consume(match);
      state.tags.push(re.group0(match));
    }

    extractEpisodeAfterMetadata(work, state);

    const residual = cleanFragment(work.residual());
    if (
      (work.segment.enclosure === 'square' || work.segment.enclosure === 'round') &&
      ['end', '生'].includes(residual.toLowerCase())
    ) {
      work.mask.fill(true);
      state.tags.push(residual);
    }
  }
}

/** Resolve episode numbers mixed into an enclosed technical tag. */
function extractEpisodeAfterMetadata(work: _WorkingSegment, state: _State): void {
  if (
    state.episode !== null ||
    state.mediaType === MediaType.MOVIE ||
    work.segment.enclosure !== 'square'
  ) {
    return;
  }
  const residual = work.residual();
  const match =
    re.matchStart(_BARE_EPISODE, residual) ?? re.search(_TRAILING_EPISODE, residual);
  if (match === null || isYearNumber(re.group(match, 1)!)) {
    return;
  }
  work.consumeSpan(re.start(match), re.end(match));
  state.setEpisode(toNumber(re.group(match, 1)!), 65, null, intOrNull(re.group(match, 2)));
  state.evidence.push('episode');
}

function reconstructTitles(
  working: _WorkingSegment[],
): [string | null, string | null, string | null] {
  const fragments: string[] = [];
  for (const work of working) {
    let residual = cleanFragment(work.residual());
    if (!residual || !containsTitleFragment(residual)) {
      continue;
    }
    if (work.segment.enclosure === 'round') {
      residual = `(${residual})`;
    }
    fragments.push(...splitExplicitTitles(residual));
  }

  const titles: Record<'en' | 'zh' | 'jp', string[]> = { en: [], zh: [], jp: [] };
  for (const fragment of fragments) {
    for (const part of splitMixedTitle(fragment)) {
      const cleaned = cleanTitle(part);
      if (!cleaned || !containsTitleFragment(cleaned)) {
        continue;
      }
      const language = titleLanguage(cleaned);
      if (!titles[language].includes(cleaned)) {
        titles[language].push(cleaned);
      }
    }
  }

  return [joinTitleParts(titles.en), joinTitleParts(titles.zh), joinTitleParts(titles.jp)];
}

function splitExplicitTitles(text: string): string[] {
  const spaced = text
    .split(_EXPLICIT_TITLE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part);
  if (spaced.length > 1) {
    return spaced;
  }

  for (const match of re.finditer(_SLASH, text)) {
    const left = text.slice(0, re.start(match)).trim();
    const right = text.slice(re.end(match)).trim();
    if (!left || !right) {
      continue;
    }
    if (/\d/.test(left[left.length - 1]) || /\d/.test(right[0])) {
      continue;
    }
    if (titleLanguage(left) !== titleLanguage(right)) {
      return [left, right];
    }
  }
  return [text];
}

function splitMixedTitle(text: string): string[] {
  const underscore = re.splitOnce(_UNDERSCORE_SPLIT, text);
  if (
    underscore.length === 2 &&
    titleLanguage(underscore[0]) !== titleLanguage(underscore[1])
  ) {
    return underscore;
  }

  const cjkToLatin = re.search(_CJK_TO_LATIN, text);
  if (cjkToLatin !== null) {
    return [text.slice(0, re.start(cjkToLatin)), text.slice(re.end(cjkToLatin))];
  }

  const words = text.trim() ? text.trim().split(/\s+/) : [];
  if (words.length < 2) {
    const runs: Array<[string, number]> = [];
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const language = _LATIN.test(char)
        ? 'en'
        : _HAN.test(char) || _KANA.test(char)
          ? 'cjk'
          : null;
      if (language !== null && (runs.length === 0 || runs[runs.length - 1][0] !== language)) {
        runs.push([language, index]);
      }
    }
    if (runs.length === 2 && runs[0][0] === 'en') {
      const boundary = runs[1][1];
      return [text.slice(0, boundary), text.slice(boundary)];
    }
    return [text];
  }

  const classes = words.map((word) => wordLanguage(word));
  if (/^\d+$/.test(words[0]) && ['zh', 'jp'].includes(classes[1])) {
    return [text];
  }
  if (/^\d+$/.test(words[words.length - 1]) && ['zh', 'jp'].includes(classes[0])) {
    return [text];
  }
  const transitions: number[] = [];
  for (let index = 1; index < classes.length; index += 1) {
    if (classes[index] !== classes[index - 1]) {
      transitions.push(index);
    }
  }
  if (transitions.length === 1) {
    const index = transitions[0];
    return [words.slice(0, index).join(' '), words.slice(index).join(' ')];
  }
  if (
    re.fullmatch(_PURE_HAN, words[0]) &&
    classes.slice(1).includes('jp') &&
    classes[classes.length - 1] === 'en'
  ) {
    const jpIndex = classes.indexOf('jp');
    let enIndex = -1;
    for (let index = jpIndex + 1; index < classes.length; index += 1) {
      if (classes[index] === 'en') {
        enIndex = index;
        break;
      }
    }
    if (enIndex > jpIndex) {
      return [
        words[0],
        words.slice(1, enIndex).join(' '),
        words.slice(enIndex).join(' '),
      ];
    }
  }
  return [text];
}

function wordLanguage(text: string): string {
  if (_KANA.test(text)) {
    return 'jp';
  }
  if (_HAN.test(text)) {
    return 'zh';
  }
  return 'en';
}

function titleLanguage(text: string): 'en' | 'zh' | 'jp' {
  if (_KANA.test(text)) {
    return 'jp';
  }
  if (_HAN.test(text)) {
    return 'zh';
  }
  return 'en';
}

function cleanFragment(text: string): string {
  let result = re.sub(_WHITESPACE, ' ', text).trim();
  result = re.sub(_EDGE_DASHES, '', result).trim();
  result = re.sub(_EDGE_PIPES, '', result).trim();
  result = re.sub(_EDGE_SLASHES, '', result).trim();
  return re.sub(_WHITESPACE, ' ', result).trim();
}

function cleanTitle(text: string): string {
  let result = cleanFragment(text);
  // 全角破折号包裹整段标题："－魔獸之王…－" → "魔獸之王…"（#1108）
  result = result.replace(_FULLWIDTH_DASH_WRAP, '$1').trim();
  return re.sub(_UNDERSCORES, ' ', result).trim();
}

function joinTitleParts(parts: string[]): string | null {
  return parts.length > 0 ? parts.join(' ').trim() : null;
}

function mostlyMetadata(text: string): boolean {
  return re.fullmatch(_MOSTLY_METADATA, text) !== null;
}

void mostlyMetadata;

function preferSubtitle(current: string | null, candidate: string): string {
  if (current === null || _HAN.test(candidate)) {
    return re.sub(_STRIP_SUBTITLE_CONTAINER, '', candidate);
  }
  return current;
}

function appendUnique(values: string[], value: string): void {
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) {
    values.push(value);
  }
}

function specialMedia(marker: string): MediaType {
  const lower = marker.toLowerCase();
  if (lower === 'ova') {
    return MediaType.OVA;
  }
  if (lower === 'oad') {
    return MediaType.OAD;
  }
  return MediaType.SPECIAL;
}

function intOrNull(value: string | null): number | null {
  return value !== null ? parseInt(value, 10) : null;
}

function chineseNumber(value: string): number {
  if (/^\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value.includes('百')) {
    const [left, right] = partition(value, '百');
    return (digits[left] ?? 1) * 100 + chineseNumber(right || '零');
  }
  if (value.includes('十')) {
    const [left, right] = partition(value, '十');
    return (digits[left] ?? 1) * 10 + (digits[right] ?? 0);
  }
  return digits[value] ?? 1;
}

/** Python str.partition：按首个分隔符切两半。 */
function partition(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator);
  if (index < 0) return [text, ''];
  return [text.slice(0, index), text.slice(index + separator.length)];
}
