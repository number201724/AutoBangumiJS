/**
 * Generic, evidence-oriented parser for anime resource names.
 *
 * Unlike the former ordered mutation pipeline, this module never reclassifies an
 * entire title fragment because it contains one marker.  It records exact matched
 * spans, removes only those spans, and reconstructs titles from the remaining
 * text.
 *
 * （镜像 parser.py —— Preview 引擎。Python re → regex.ts 适配层；Python re 的
 * Unicode \w/\b 边界 → [\p{L}\p{N}_]（W）以保持多语言标题下的边界语义一致。）
 */

import {
  Candidate,
  Claims,
  DecisionStatus,
  Observation,
  OverlapPolicy,
  ShadowedSpanPolicy,
  Span,
  spanTuplesEqual,
} from './candidate';
import { normalize } from './normalization';
import * as re from './regex';
import { Resolution, resolveCandidates } from './resolver';
import { MediaType, ParsedRelease, ReleaseKind, makeParsedRelease } from '../types';
import { ParseOutcome, ParseTrace, TraceSegment } from './trace';

// Python re 的 Unicode \w 等价物（字母 + 数字 + 下划线）
const W = '\\p{L}\\p{N}_';

const _TITLE_CHAR = /[A-Za-z぀-ヿ㐀-鿿豈-﫿]/u;
const _HAN = /[㐀-䶿一-鿿豈-﫿]/u;
const _PURE_HAN = /[㐀-䶿一-鿿豈-﫿]+/u;
const _KANA = /[぀-ヿ]/u;
const _LATIN = /[A-Za-z]/u;
const _NUMERIC_TITLE = /\d{1,3}(?:\s*[\/.-]\s*\d{1,3})?/u;

const _DATE = /(?<!\d)(?:19|20)\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}(?!\d)/u;
const _ORGANIZED_DATE_CONTEXT =
  /^\s*整理时间\s*[:：]\s*((?:19|20)\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2})\s*$/u;
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
const _SEASON_EPISODE_RANGE = new RegExp(
  `(?<![${W}])S(\\d{1,2})\\s*E(?:P)?\\.?\\s*(\\d{1,4}(?:\\.\\d+)?)\\s*` +
    `(?:-|~|～|—)\\s*(?:E(?:P)?\\.?\\s*)?(\\d{1,4}(?:\\.\\d+)?)` +
    `(?:v(\\d+))?(?![${W}])`,
  'iu',
);
const _SEASON_EPISODE_WORDS = new RegExp(
  `(?<![${W}])Season\\s+(\\d{1,2})\\s+(?:Episode|EP?\\.?)\\s*` +
    `(\\d{1,4}(?:\\.\\d+)?)(?:v(\\d+))?(?![${W}])`,
  'iu',
);
const _SEASON_EPISODE_WORDS_RANGE = new RegExp(
  `(?<![${W}])Season\\s+(\\d{1,2})\\s+(?:Episodes?|EPs?\\.?)\\s*` +
    `(\\d{1,4}(?:\\.\\d+)?)\\s*(?:-|~|～|—)\\s*` +
    `(?:E(?:P)?\\.?\\s*)?(\\d{1,4}(?:\\.\\d+)?)(?:v(\\d+))?(?![${W}])`,
  'iu',
);
const _SEASON = new RegExp(`(?<![${W}])(S\\d{1,2}|Season\\s+\\d{1,2})(?![${W}])`, 'iu');
const _ORDINAL_SEASON = new RegExp(
  `(?<![${W}])(\\d{1,2})(?:st|nd|rd|th)\\s+Season(?![${W}])`,
  'iu',
);
const _CHINESE_SEASON = /第([零〇一二两三四五六七八九十百\d]+)[季期]/u;
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
const _SPECIAL_RANGE =
  /(?<![A-Za-z0-9])(OVA|OAD|SP|Special)\s*(?:[-_.]\s*)?(\d{1,4}(?:\.\d+)?)\s*(?:-|~|～|—)\s*(?:\1\s*)?(\d{1,4}(?:\.\d+)?)(?:v(\d+))?(?![A-Za-z0-9])/iu;
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

const _MIXED_CONTENT_NAME =
  String.raw`TV(?:\s*(?:动画|動畫|Anime))?|OVA|OAD|Special|SP|Movie|` +
  String.raw`劇場版?|剧场版?|Manga|漫画|漫畫|Novel|小说|小說|` +
  String.raw`Music|音乐|音樂|Other|其他|Extras?`;
const _MIXED_CONTENT_NUMBERS = String.raw`(?:\s*(?:E(?:P)?\.?\s*)?\d{1,4}(?:\s*(?:-|~|～|—)\s*(?:E(?:P)?\.?\s*)?\d{1,4})?)?`;
const _MIXED_CONTENT_ITEM = `(?:${_MIXED_CONTENT_NAME})${_MIXED_CONTENT_NUMBERS}`;
const _MIXED_CONTENT_MANIFEST = new RegExp(
  `(?<![A-Za-z0-9])(?<items>${_MIXED_CONTENT_ITEM}` +
    `(?:\\s*[+＋]\\s*${_MIXED_CONTENT_ITEM})+)\\s*(?=$|[；;_])`,
  'iu',
);
const _MIXED_CONTENT_NAME_AT_START = new RegExp(`^(?<name>${_MIXED_CONTENT_NAME})`, 'iu');
const _MIXED_CONTENT_TAIL_TOKEN = new RegExp(
  `(?<![${W}])(?:dub|jpn?|chs|cht|eng|subs?|audio|tracks?|external)(?![${W}])|` +
    String.raw`(?:日[语語]|英[语語]|中[文语語]|简中|簡中|繁中|外挂|外掛|音[轨軌]|字幕)`,
  'iu',
);

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

// 内联小 pattern（对应 parser.py 中的字面 re 调用）
const _GROUP_CJK = /字幕[组組社]?|搬运|搬運|压制|壓制|发布|發佈/u;
const _GROUP_LATIN = /raws?|fansub|subs?|house|studio|group|team|rip/u;
const _GROUP_FAN = /(?:^|[-_. ])fan(?:$|[-_. ])/u;
const _GROUP_TOKEN = /[A-Z0-9.-]+/u;
const _DIGITS = /\d+/u;
const _SEPARATOR_BEFORE = /\s+-\s*$/u;
const _EPISODE_TITLE_AFTER = /\s*-\s*(.+?)\s*/u;
const _COMPACT_RANGE = /\d(?:-|~|～|—)(?:E(?:P)?\.?\s*)?\d/iu;
const _RANGE_LABEL = /(?:Episodes?|Eps?)\s*$/iu;
const _SLASH_SUFFIX = /\d+\s*\/\s*$/u;
const _LATIN_START = /^[A-Za-z]/u;
const _TRAILING_COLON = /[:：]\s*$/u;
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
const _MIXED_TAIL_STRIP = /[\s_;；:：,，/|+.-]+/u;
const _PLUS_SPLIT = /\s*[+＋]\s*/u;

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

class _ResidualSegment {
  readonly mask: boolean[];

  constructor(readonly segment: _Segment) {
    this.mask = new Array<boolean>(segment.text.length).fill(false);
  }

  maskSpan(start: number, end: number): void {
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

interface _AddSpanArgs {
  ruleId: string;
  kind: string;
  segmentIndex: number;
  start: number;
  end: number;
  claims?: Claims;
  priority?: number;
  specificity?: number;
  evidence?: string[];
  extraSpans?: Span[];
  conflictTags?: Set<string>;
  blocks?: Set<string>;
  preserveAsTitleOnConflict?: boolean;
  shadowedSpanPolicy?: ShadowedSpanPolicy;
  overlapPolicy?: OverlapPolicy;
  captures?: Array<string | null>;
}

class _CandidateCollector {
  readonly observations: Observation[] = [];
  readonly candidates: Candidate[] = [];

  constructor(
    readonly segments: _Segment[],
    readonly captureObservations: boolean = false,
  ) {}

  addSpan(args: _AddSpanArgs): Candidate {
    const span = new Span(args.segmentIndex, args.start, args.end);
    const suffix = `${args.segmentIndex}:${args.start}:${args.end}`;
    const candidateId = `${args.ruleId}:${suffix}`;
    const observationIds: string[] = [];
    if (this.captureObservations) {
      const observationId = `observation:${candidateId}`;
      observationIds.push(observationId);
      this.observations.push(
        new Observation(
          observationId,
          args.ruleId,
          args.kind,
          span,
          this.segments[args.segmentIndex].text.slice(args.start, args.end),
          args.captures ?? [],
        ),
      );
    }
    const extraSpans = args.extraSpans ?? [];
    const candidate = new Candidate(
      candidateId,
      args.ruleId,
      [span, ...extraSpans],
      args.claims ?? new Claims(),
      args.priority ?? 0,
      args.specificity ?? 0,
      observationIds,
      args.evidence ?? [],
      args.conflictTags ?? new Set(),
      args.blocks ?? new Set(),
      args.preserveAsTitleOnConflict ?? false,
      args.shadowedSpanPolicy ?? ShadowedSpanPolicy.EXCLUDE,
      extraSpans.length > 0 ? [span] : null,
      args.overlapPolicy ?? OverlapPolicy.EXCLUSIVE,
    );
    this.candidates.push(candidate);
    return candidate;
  }

  addMatch(
    args: Omit<_AddSpanArgs, 'start' | 'end' | 'captures'> & { match: RegExpExecArray },
  ): Candidate {
    const { match, ...rest } = args;
    return this.addSpan({
      ...rest,
      start: re.start(match),
      end: re.end(match),
      captures: re.groups(match),
    });
  }

  addSegments(args: {
    ruleId: string;
    kind: string;
    segmentIndices: number[];
    claims: Claims;
    priority: number;
    evidence?: string[];
  }): Candidate {
    const spans = args.segmentIndices.map(
      (index) => new Span(index, 0, this.segments[index].text.length),
    );
    const observationIds: string[] = [];
    if (this.captureObservations) {
      for (const span of spans) {
        const observationId = `observation:${args.ruleId}:${span.segment}:${span.start}:${span.end}`;
        observationIds.push(observationId);
        this.observations.push(
          new Observation(
            observationId,
            args.ruleId,
            args.kind,
            span,
            this.segments[span.segment].text,
          ),
        );
      }
    }
    const candidate = new Candidate(
      `${args.ruleId}:${args.segmentIndices.join(',')}`,
      args.ruleId,
      spans,
      args.claims,
      args.priority,
      0,
      observationIds,
      args.evidence ?? [],
    );
    this.candidates.push(candidate);
    return candidate;
  }
}

/** Parse a resource name without requiring an episode number. */
export function parseReleaseTitle(raw: string): ParsedRelease | null {
  const [result] = parseReleaseTitleWithCandidates(raw, false);
  return result;
}

/** Parse a resource name together with immutable resolver diagnostics. */
export function parseReleaseTitleWithTrace(raw: string): ParseOutcome {
  const [result, trace] = parseReleaseTitleWithCandidates(raw, true);
  return new ParseOutcome(result, trace!);
}

function parseReleaseTitleWithCandidates(
  raw: string,
  captureTrace: boolean,
): [ParsedRelease | null, ParseTrace | null] {
  const normalized = raw && raw.trim() ? normalize(raw) : '';
  const segments = normalized ? scanSegments(normalized) : [];
  if (segments.length === 0) {
    const trace = captureTrace ? new ParseTrace(raw, normalized) : null;
    return [null, trace];
  }

  const collector = new _CandidateCollector(segments, captureTrace);
  collectGroupCandidates(collector);
  collectStructuralCandidates(collector);
  collectMediaCandidates(collector);
  collectTechnicalCandidates(collector);
  collectMetadataEpisodeCandidates(collector);

  const resolution = resolveCandidates(collector.candidates, captureTrace);
  const working = workingFromSpans(segments, resolution.excludedSpans);
  let [titleEn, titleZh, titleJp] = reconstructTitles(working);
  if (!(titleEn || titleZh || titleJp) && isMixedResolution(resolution)) {
    const retrySpans = mixedTitleRetrySpans(collector.candidates, resolution);
    if (!spanTuplesEqual(retrySpans, resolution.excludedSpans)) {
      const retryWorking = workingFromSpans(segments, retrySpans);
      const retryTitles = reconstructTitles(retryWorking);
      if (retryTitles.some((title) => title !== null)) {
        [titleEn, titleZh, titleJp] = retryTitles;
      }
    }
  }
  let result: ParsedRelease | null = null;
  if (titleEn || titleZh || titleJp || isMixedResolution(resolution)) {
    result = resultFromResolution(raw, titleEn, titleZh, titleJp, resolution);
  }

  let trace: ParseTrace | null = null;
  if (captureTrace) {
    trace = ParseTrace.fromResolution({
      raw,
      normalized,
      resolution,
      segments: traceSegments(segments),
      observations: collector.observations,
      candidates: collector.candidates,
      residuals: working.map((work) => work.residual()),
    });
  }
  return [result, trace];
}

function isMixedResolution(resolution: Resolution): boolean {
  return (
    resolution.claims.media_type === MediaType.UNKNOWN &&
    resolution.claims.release_kind === ReleaseKind.COLLECTION
  );
}

/** Keep an ambiguous numeric episode only when it is the sole mixed title. */
function mixedTitleRetrySpans(
  candidates: Candidate[],
  resolution: Resolution,
): Span[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const spans: Span[] = [];
  for (const decision of resolution.decisions) {
    const candidate = byId.get(decision.candidateId)!;
    const ambiguousEpisode =
      decision.status === DecisionStatus.SELECTED &&
      candidate.preserveAsTitleOnConflict &&
      candidate.conflictTags.has('ambiguous-episode');
    if (!ambiguousEpisode) {
      spans.push(...decision.excludedSpans);
    }
  }
  return spans;
}

function resultFromResolution(
  raw: string,
  titleEn: string | null,
  titleZh: string | null,
  titleJp: string | null,
  resolution: Resolution,
): ParsedRelease {
  const claims = resolution.claims;
  let mediaType = claims.media_type;
  if (
    mediaType === null &&
    (claims.episode !== null || claims.release_kind !== null)
  ) {
    mediaType = MediaType.EPISODE;
  }
  const resolvedMediaType = mediaType ?? MediaType.UNKNOWN;
  const releaseKind = claims.release_kind ?? ReleaseKind.SINGLE;
  const mixedCollection =
    resolvedMediaType === MediaType.UNKNOWN && releaseKind === ReleaseKind.COLLECTION;
  let evidence = resolution.evidence;
  if (mixedCollection) {
    // The trace keeps pre-normalization resolver claims for diagnostics, but
    // the public collection must not advertise a single-episode identity.
    evidence = evidence.filter(
      (item) => !['season', 'episode', 'episode-title', 'episode-range'].includes(item),
    );
  }
  return makeParsedRelease({
    raw,
    title_en: titleEn,
    title_zh: titleZh,
    title_jp: titleJp,
    group: claims.group,
    season: mixedCollection ? null : claims.season,
    season_raw: mixedCollection ? null : claims.season_raw,
    episode: mixedCollection ? null : claims.episode,
    episode_end: mixedCollection ? null : claims.episode_end,
    episode_title: mixedCollection ? null : claims.episode_title,
    media_type: resolvedMediaType,
    release_kind: releaseKind,
    resolution: claims.resolution,
    source: claims.source,
    subtitle: claims.subtitle,
    codecs: [...claims.codecs],
    audio: [...claims.audio],
    container: claims.container,
    version: claims.version,
    year: claims.year,
    tags: [...claims.tags],
    evidence,
  });
}

function workingFromSpans(
  segments: _Segment[],
  excludedSpans: readonly Span[],
): _ResidualSegment[] {
  const working = segments.map((segment) => new _ResidualSegment(segment));
  for (const span of excludedSpans) {
    working[span.segment].maskSpan(span.start, span.end);
  }
  return working;
}

function traceSegments(segments: _Segment[]): TraceSegment[] {
  const traced: TraceSegment[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const enclosed = segment.enclosure !== null;
    const contentStart = enclosed ? segment.start + 1 : segment.start;
    traced.push(
      new TraceSegment(
        index,
        segment.text,
        segment.start,
        segment.end,
        contentStart,
        contentStart + segment.text.length,
        segment.enclosure,
      ),
    );
  }
  return traced;
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
  if (segments.length === 0) return new Set();

  let firstFreeTitle: number | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      segment.enclosure === null &&
      containsTitleFragment(segment.text) &&
      !looksLikeMetadata(segment.text)
    ) {
      firstFreeTitle = index;
      break;
    }
  }
  const hasFreeTitle = firstFreeTitle !== null;

  let groupIndex: number | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      segment.enclosure === 'square' &&
      (firstFreeTitle === null || index < firstFreeTitle) &&
      !looksLikeMetadata(segment.text) &&
      (looksLikeGroup(segment.text) || hasFreeTitle)
    ) {
      groupIndex = index;
      break;
    }
  }
  if (groupIndex === null) return new Set();

  const indices = new Set<number>([groupIndex]);
  for (let index = groupIndex + 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      segment.enclosure !== 'square' ||
      looksLikeMetadata(segment.text) ||
      !looksLikeGroup(segment.text)
    ) {
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
  if (_GROUP_FAN.test(lower)) return true;
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
    _SEASON_EPISODE_RANGE,
    _SEASON_EPISODE_WORDS_RANGE,
    _SEASON_EPISODE,
    _SEASON_EPISODE_WORDS,
    _SEASON,
    _CHINESE_SEASON,
    _FULL_COLLECTION,
    _CHINESE_EPISODE,
    _BARE_EPISODE,
    _SPECIAL_NUMBER,
    _SPECIAL_RANGE,
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
  if (value.includes('+') || value.includes('＋')) {
    const manifest = re.matchStart(_MIXED_CONTENT_MANIFEST, value);
    if (manifest !== null) {
      const categories = mixedContentCategories(manifest.groups!['items']);
      const suffix = value.slice(re.end(manifest));
      if (
        categories.size >= 2 &&
        (!suffix || isMixedContentMetadataTail(suffix))
      ) {
        return true;
      }
    }
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

function trailingReleaseEpisode(text: string): RegExpExecArray | null {
  const match = re.search(_TRAILING_EPISODE, text);
  if (match === null || isYearNumber(re.group(match, 1)!)) {
    return null;
  }
  return match;
}

function collectGroupCandidates(collector: _CandidateCollector): Set<number> {
  const groupIndices = findGroupSegments(collector.segments);
  if (groupIndices.size === 0) return new Set();
  const ordered = [...groupIndices].sort((a, b) => a - b);
  collector.addSegments({
    ruleId: 'group.square-prefix',
    kind: 'group',
    segmentIndices: ordered,
    claims: new Claims({
      group: ordered.map((index) => collector.segments[index].text.trim()).join('&'),
    }),
    priority: 1000,
    evidence: ['group'],
  });
  return groupIndices;
}

function episodeTitleParts(
  segmentIndex: number,
  text: string,
  match: RegExpExecArray,
): [string | null, Span[]] {
  const spans: Span[] = [];
  const before = text.slice(0, re.start(match));
  const separator = re.search(_SEPARATOR_BEFORE, before);
  if (separator !== null) {
    spans.push(new Span(segmentIndex, re.start(separator), re.start(match)));
  }

  const after = text.slice(re.end(match));
  const episodeTitle = re.fullmatch(_EPISODE_TITLE_AFTER, after);
  if (episodeTitle === null || !containsTitleFragment(re.group(episodeTitle, 1)!)) {
    return [null, spans];
  }
  spans.push(new Span(segmentIndex, re.end(match), text.length));
  return [cleanTitle(re.group(episodeTitle, 1)!), spans];
}

function collectStructuralCandidates(collector: _CandidateCollector): void {
  for (let index = 0; index < collector.segments.length; index += 1) {
    const segment = collector.segments[index];
    const text = segment.text;

    const organizedDate = re.fullmatch(_ORGANIZED_DATE_CONTEXT, text);
    if (
      organizedDate !== null &&
      (segment.enclosure === 'square' || segment.enclosure === 'round')
    ) {
      collector.addSpan({
        ruleId: 'metadata.organized-date',
        kind: 'tag',
        segmentIndex: index,
        start: 0,
        end: text.length,
        claims: new Claims({ tags: [re.group(organizedDate, 1)!] }),
        priority: 111,
      });
    }

    for (const match of re.finditer(_DATE, text)) {
      collector.addMatch({
        ruleId: 'metadata.date',
        kind: 'tag',
        segmentIndex: index,
        match,
        claims: new Claims({ tags: [re.group0(match)] }),
        priority: 110,
      });
    }

    for (const match of re.finditer(_FILE_SIZE, text)) {
      collector.addMatch({
        ruleId: 'metadata.file-size',
        kind: 'tag',
        segmentIndex: index,
        match,
        claims: new Claims({ tags: [re.group0(match)] }),
        priority: 110,
      });
    }

    for (const match of re.finditer(_YEAR, text)) {
      if (re.group0(match) !== text.trim() && !isMetadataTail(text.slice(re.end(match)))) {
        continue;
      }
      collector.addMatch({
        ruleId: 'metadata.year',
        kind: 'year',
        segmentIndex: index,
        match,
        claims: new Claims({ year: parseInt(re.group(match, 1)!, 10) }),
        priority: 100,
        evidence: ['year'],
      });
    }

    const seasonRangeRules: Array<[string, RegExp]> = [
      ['episode.season-range-compact', _SEASON_EPISODE_RANGE],
      ['episode.season-range-words', _SEASON_EPISODE_WORDS_RANGE],
    ];
    for (const [ruleId, pattern] of seasonRangeRules) {
      for (const match of re.finditer(pattern, text)) {
        const rangeStart = toNumber(re.group(match, 2)!);
        const rangeEnd = toNumber(re.group(match, 3)!);
        if (rangeStart >= 1800 || rangeEnd >= 1800 || rangeStart > rangeEnd) {
          continue;
        }
        collector.addMatch({
          ruleId,
          kind: 'season-episode-range',
          segmentIndex: index,
          match,
          claims: new Claims({
            season: parseInt(re.group(match, 1)!, 10),
            season_raw: re.group0(match),
            episode: rangeStart,
            episode_end: rangeEnd,
            release_kind: ReleaseKind.RANGE,
            version: intOrNull(re.group(match, 4)),
          }),
          priority: 105,
          specificity: 5,
          evidence: ['season', 'episode-range'],
        });
      }
    }

    for (const match of re.finditer(_SPECIAL_RANGE, text)) {
      const rangeStart = toNumber(re.group(match, 2)!);
      const rangeEnd = toNumber(re.group(match, 3)!);
      if (rangeStart >= 1800 || rangeEnd >= 1800 || rangeStart > rangeEnd) {
        continue;
      }
      const mediaType = specialMedia(re.group(match, 1)!);
      collector.addMatch({
        ruleId: `episode.${mediaType}-range`,
        kind: 'special-episode-range',
        segmentIndex: index,
        match,
        claims: new Claims({
          episode: rangeStart,
          episode_end: rangeEnd,
          media_type: mediaType,
          release_kind: ReleaseKind.RANGE,
          version: intOrNull(re.group(match, 4)),
        }),
        priority: 105,
        specificity: 5,
        evidence: [mediaType, 'episode-range'],
      });
    }

    for (const match of re.finditer(_RANGE, text)) {
      const rangeStart = toNumber(re.group(match, 1)!);
      const rangeEnd = toNumber(re.group(match, 2)!);
      const prefix = text.slice(0, re.start(match));
      const suffix = text.slice(re.end(match));
      const compact = _COMPACT_RANGE.test(re.group0(match));
      const isolated = !containsTitle(prefix + suffix);
      const labelled = _RANGE_LABEL.test(prefix);
      const explicitEndpoints = re.finditer(_EXPLICIT_EPISODE, re.group0(match)).length;
      const strongStructurePatterns = [
        _SEASON_EPISODE_RANGE,
        _SEASON_EPISODE_WORDS_RANGE,
        _SEASON_EPISODE,
        _SEASON_EPISODE_WORDS,
        _SPECIAL_RANGE,
        _SPECIAL_NUMBER,
        _EXPLICIT_EPISODE,
        _CHINESE_EPISODE,
      ];
      const hasPriorStructure =
        strongStructurePatterns.some((pattern) => re.search(pattern, prefix) !== null) ||
        collector.segments
          .slice(0, index)
          .some((prior) =>
            strongStructurePatterns.some((pattern) => re.search(pattern, prior.text) !== null),
          );
      const strongLabelledRange =
        explicitEndpoints === 2 &&
        !hasPriorStructure &&
        trailingReleaseEpisode(suffix) === null &&
        isMetadataTail(suffix);
      if (
        rangeStart >= 1800 ||
        rangeEnd >= 1800 ||
        rangeStart > rangeEnd ||
        _SLASH_SUFFIX.test(prefix) ||
        trailingReleaseEpisode(suffix) !== null ||
        !(compact || isolated || labelled || strongLabelledRange)
      ) {
        continue;
      }
      collector.addMatch({
        ruleId: 'episode.range',
        kind: 'episode-range',
        segmentIndex: index,
        match,
        claims: new Claims({
          episode: rangeStart,
          episode_end: rangeEnd,
          release_kind: ReleaseKind.RANGE,
          version: intOrNull(re.group(match, 3)),
        }),
        priority: 95,
        specificity: 3,
        evidence: ['episode-range'],
      });
    }

    const seasonEpisodeRules: Array<[string, RegExp]> = [
      ['episode.season-compact', _SEASON_EPISODE],
      ['episode.season-words', _SEASON_EPISODE_WORDS],
    ];
    for (const [ruleId, pattern] of seasonEpisodeRules) {
      for (const match of re.finditer(pattern, text)) {
        const [episodeTitle, extraSpans] = episodeTitleParts(index, text, match);
        const evidence = ['season', 'episode'];
        if (episodeTitle) {
          evidence.push('episode-title');
        }
        collector.addMatch({
          ruleId,
          kind: 'season-episode',
          segmentIndex: index,
          match,
          claims: new Claims({
            season: parseInt(re.group(match, 1)!, 10),
            season_raw: re.group0(match),
            episode: toNumber(re.group(match, 2)!),
            episode_title: episodeTitle,
            version: intOrNull(re.group(match, 3)),
          }),
          priority: 100,
          specificity: 4,
          evidence,
          extraSpans,
        });
      }
    }

    for (const match of re.finditer(_SPECIAL_NUMBER, text)) {
      const mediaType = specialMedia(re.group(match, 1)!);
      collector.addMatch({
        ruleId: `episode.${mediaType}-numbered`,
        kind: 'special-episode',
        segmentIndex: index,
        match,
        claims: new Claims({
          episode: toNumber(re.group(match, 2)!),
          media_type: mediaType,
          version: intOrNull(re.group(match, 3)),
        }),
        priority: 80,
        specificity: 3,
        evidence: [mediaType, 'episode'],
      });
    }

    for (const match of re.finditer(_PV, text)) {
      if (re.group(match, 2) === null) {
        continue;
      }
      collector.addMatch({
        ruleId: 'media.pv-numbered',
        kind: 'non-episode-video',
        segmentIndex: index,
        match,
        claims: new Claims({
          episode: toNumber(re.group(match, 2)!),
          media_type: MediaType.PV,
        }),
        priority: 75,
        specificity: 2,
        evidence: ['pv', 'episode'],
      });
    }

    for (const match of re.finditer(_SEASON, text)) {
      const numberMatch = re.search(_DIGITS, re.group(match, 1)!);
      if (numberMatch !== null) {
        collector.addMatch({
          ruleId: 'season.marker',
          kind: 'season',
          segmentIndex: index,
          match,
          claims: new Claims({
            season: parseInt(re.group0(numberMatch), 10),
            season_raw: re.group(match, 1),
          }),
          priority: 80,
          evidence: ['season'],
        });
      }
    }

    for (const match of re.finditer(_CHINESE_SEASON, text)) {
      collector.addMatch({
        ruleId: 'season.chinese',
        kind: 'season',
        segmentIndex: index,
        match,
        claims: new Claims({
          season: chineseNumber(re.group(match, 1)!),
          season_raw: re.group0(match),
        }),
        priority: 80,
        evidence: ['season'],
      });
    }

    for (const match of re.finditer(_ORDINAL_SEASON, text)) {
      collector.addMatch({
        ruleId: 'season.ordinal',
        kind: 'season',
        segmentIndex: index,
        match,
        claims: new Claims({
          season: parseInt(re.group(match, 1)!, 10),
          season_raw: re.group0(match),
        }),
        priority: 50,
        evidence: ['season'],
        shadowedSpanPolicy: ShadowedSpanPolicy.KEEP,
      });
    }

    for (const match of re.finditer(_FULL_COLLECTION, text)) {
      collector.addMatch({
        ruleId: 'episode.full-collection',
        kind: 'collection',
        segmentIndex: index,
        match,
        claims: new Claims({
          episode: 1,
          episode_end: parseInt(re.group(match, 1)!, 10),
          release_kind: ReleaseKind.COLLECTION,
        }),
        priority: 95,
        specificity: 3,
        evidence: ['collection', 'episode-range'],
      });
    }

    for (const match of re.finditer(_EXPLICIT_EPISODE, text)) {
      if (insideRangeBeforeTrailingEpisode(text, match)) {
        continue;
      }
      collector.addMatch({
        ruleId: 'episode.explicit',
        kind: 'episode',
        segmentIndex: index,
        match,
        claims: new Claims({
          episode: toNumber(re.group(match, 1)!),
          version: intOrNull(re.group(match, 2)),
        }),
        priority: 90,
        specificity: 2,
        evidence: ['episode'],
      });
    }

    for (const match of re.finditer(_CHINESE_EPISODE, text)) {
      collector.addMatch({
        ruleId: 'episode.chinese',
        kind: 'episode',
        segmentIndex: index,
        match,
        claims: new Claims({ episode: toNumber(re.group(match, 1)!) }),
        priority: 90,
        specificity: 2,
        evidence: ['episode'],
      });
    }

    const specialEpisodeRules: Array<[string, RegExp]> = [
      ['episode.pre', _PRE_EPISODE],
      ['episode.compound', _COMPOUND_EPISODE],
      ['episode.atlas', _ATLAS_EPISODE],
    ];
    for (const [ruleId, pattern] of specialEpisodeRules) {
      const specialMatch = re.matchStart(pattern, text);
      if (specialMatch !== null) {
        collector.addMatch({
          ruleId,
          kind: 'episode',
          segmentIndex: index,
          match: specialMatch,
          claims: new Claims({ episode: toNumber(re.group(specialMatch, 1)!) }),
          priority: 75,
          evidence: ['episode'],
        });
      }
    }

    const trailing = re.search(_TRAILING_EPISODE, text);
    if (trailing !== null && !isYearNumber(re.group(trailing, 1)!)) {
      collector.addMatch({
        ruleId: 'episode.trailing',
        kind: 'episode',
        segmentIndex: index,
        match: trailing,
        claims: new Claims({
          episode: toNumber(re.group(trailing, 1)!),
          version: intOrNull(re.group(trailing, 2)),
        }),
        priority: 70,
        evidence: ['episode'],
        conflictTags: new Set(['ambiguous-episode']),
        preserveAsTitleOnConflict: true,
      });
    }

    const bare = re.matchStart(_BARE_EPISODE, text);
    if (bare !== null && !isYearNumber(re.group(bare, 1)!)) {
      collector.addMatch({
        ruleId: 'episode.bare',
        kind: 'episode',
        segmentIndex: index,
        match: bare,
        claims: new Claims({
          episode: toNumber(re.group(bare, 1)!),
          version: intOrNull(re.group(bare, 2)),
        }),
        priority: 70,
        evidence: ['episode'],
        conflictTags: new Set(['ambiguous-episode']),
        preserveAsTitleOnConflict: true,
      });
    }
  }
}

function collectMediaCandidates(collector: _CandidateCollector): void {
  for (let index = 0; index < collector.segments.length; index += 1) {
    const segment = collector.segments[index];
    const text = segment.text;

    const mixedMatches =
      text.includes('+') || text.includes('＋')
        ? re.finditer(_MIXED_CONTENT_MANIFEST, text)
        : [];
    for (const match of mixedMatches) {
      const prefix = text.slice(0, re.start(match));
      const strippedPrefix = prefix.trimEnd();
      const freeSegment = segment.enclosure === null;
      const afterColon =
        freeSegment && (strippedPrefix.endsWith(':') || strippedPrefix.endsWith('：'));
      const afterUnderscore = freeSegment && strippedPrefix.endsWith('_');
      const independentSquare = segment.enclosure === 'square' && !strippedPrefix;
      if (!(afterColon || afterUnderscore || independentSquare)) {
        continue;
      }
      const categories = mixedContentCategories(match.groups!['items']);
      if (categories.size < 2) {
        continue;
      }

      const start = afterColon ? strippedPrefix.length - 1 : re.start(match);
      let extraSpans: Span[] = [];
      if (independentSquare && index > 0) {
        const previous = collector.segments[index - 1];
        const trailingColon = re.search(_TRAILING_COLON, previous.text);
        if (previous.enclosure === null && trailingColon !== null) {
          extraSpans = [new Span(index - 1, re.start(trailingColon), re.end(trailingColon))];
        }
      }
      collector.addSpan({
        ruleId: 'cardinality.mixed-content',
        kind: 'mixed-collection',
        segmentIndex: index,
        start,
        end: re.end(match),
        claims: new Claims({
          media_type: MediaType.UNKNOWN,
          release_kind: ReleaseKind.COLLECTION,
        }),
        priority: 110,
        specificity: categories.size,
        evidence: ['collection', 'mixed-content'],
        extraSpans,
        captures: [match.groups!['items']],
      });

      const suffix = text.slice(re.end(match));
      if (suffix && isMixedContentMetadataTail(suffix)) {
        collector.addSpan({
          ruleId: 'metadata.mixed-content-tail',
          kind: 'tag',
          segmentIndex: index,
          start: re.end(match),
          end: text.length,
          priority: 25,
          overlapPolicy: OverlapPolicy.SHARED,
        });
      }
    }

    const movieRules: Array<[string, RegExp]> = [
      ['media.movie-cjk', _MOVIE_CJK],
      ['media.movie-romaji', _MOVIE_ROMAJI],
    ];
    for (const [ruleId, pattern] of movieRules) {
      for (const match of re.finditer(pattern, text)) {
        collector.addMatch({
          ruleId,
          kind: 'movie',
          segmentIndex: index,
          match,
          claims: new Claims({ media_type: MediaType.MOVIE }),
          priority: 100,
          specificity: 2,
          evidence: ['movie'],
          blocks: new Set(['ambiguous-episode']),
        });
      }
    }

    for (const match of re.finditer(_MOVIE_EN, text)) {
      const before = text.slice(0, re.start(match)).trimEnd();
      const after = text.slice(re.end(match)).trimStart();
      const markerIsEdge = !before || !after || segment.enclosure === 'square';
      if (_LATIN_START.test(after)) {
        continue;
      }
      collector.addMatch({
        ruleId: 'media.movie-english',
        kind: 'movie',
        segmentIndex: index,
        match,
        claims: new Claims({ media_type: MediaType.MOVIE }),
        priority: markerIsEdge ? 100 : 99,
        specificity: 2,
        evidence: ['movie'],
        blocks: new Set(['ambiguous-episode']),
      });
    }

    for (const match of re.finditer(_SPECIAL_WORD, text)) {
      const after = text.slice(re.end(match)).trimStart();
      if (_LATIN_START.test(after)) {
        continue;
      }
      const mediaType = specialMedia(re.group(match, 1)!);
      collector.addMatch({
        ruleId: `media.${mediaType}`,
        kind: 'special',
        segmentIndex: index,
        match,
        claims: new Claims({ media_type: mediaType }),
        priority: 80,
        specificity: 1,
        evidence: [mediaType],
      });
    }

    for (const match of re.finditer(_SPECIAL_CJK, text)) {
      collector.addMatch({
        ruleId: 'media.special-cjk',
        kind: 'special',
        segmentIndex: index,
        match,
        claims: new Claims({ media_type: MediaType.SPECIAL }),
        priority: 80,
        evidence: ['special'],
      });
    }

    for (const match of re.finditer(_PV, text)) {
      if (re.group(match, 2) !== null) {
        continue;
      }
      collector.addMatch({
        ruleId: 'media.pv',
        kind: 'non-episode-video',
        segmentIndex: index,
        match,
        claims: new Claims({ media_type: MediaType.PV }),
        priority: 60,
        evidence: ['pv'],
      });
    }

    const ncRules: Array<[string, RegExp, MediaType, string]> = [
      ['media.opening', _NCOP, MediaType.OPENING, 'opening'],
      ['media.ending', _NCED, MediaType.ENDING, 'ending'],
    ];
    for (const [ruleId, pattern, mediaType, evidence] of ncRules) {
      for (const match of re.finditer(pattern, text)) {
        collector.addMatch({
          ruleId,
          kind: 'non-episode-video',
          segmentIndex: index,
          match,
          claims: new Claims({
            media_type: mediaType,
            version: intOrNull(re.group(match, 1)),
          }),
          priority: 60,
          evidence: [evidence],
        });
      }
    }

    for (const match of re.finditer(_BATCH, text)) {
      collector.addMatch({
        ruleId: 'cardinality.batch',
        kind: 'batch',
        segmentIndex: index,
        match,
        claims: new Claims({ release_kind: ReleaseKind.BATCH }),
        priority: 80,
        evidence: ['batch'],
      });
    }

    for (const match of re.finditer(_COLLECTION, text)) {
      collector.addMatch({
        ruleId: 'cardinality.collection',
        kind: 'collection',
        segmentIndex: index,
        match,
        claims: new Claims({ release_kind: ReleaseKind.COLLECTION }),
        priority: 80,
        evidence: ['collection'],
      });
    }
  }
}

const _TECHNICAL_PATTERNS = [_RESOLUTION, _SOURCE, _CODEC, _AUDIO, _SUBTITLE, _CONTAINER];

function patternResidual(text: string, patterns: RegExp[]): string {
  const mask = new Array<boolean>(text.length).fill(false);
  for (const pattern of patterns) {
    for (const match of re.finditer(pattern, text)) {
      mask.fill(true, re.start(match), re.end(match));
    }
  }
  let result = '';
  for (let i = 0; i < text.length; i += 1) {
    result += mask[i] ? ' ' : text[i];
  }
  return result;
}

function collectTechnicalCandidates(collector: _CandidateCollector): void {
  for (let index = 0; index < collector.segments.length; index += 1) {
    const segment = collector.segments[index];
    const text = segment.text;

    for (const match of re.finditer(_RESOLUTION, text)) {
      collector.addMatch({
        ruleId: 'technical.resolution',
        kind: 'resolution',
        segmentIndex: index,
        match,
        claims: new Claims({ resolution: re.group0(match) }),
        priority: 30,
        evidence: ['resolution'],
      });
    }

    for (const match of re.finditer(_SOURCE, text)) {
      collector.addMatch({
        ruleId: 'technical.source',
        kind: 'source',
        segmentIndex: index,
        match,
        claims: new Claims({ source: re.group0(match) }),
        priority: 30,
        evidence: ['source'],
      });
    }

    for (const match of re.finditer(_CODEC, text)) {
      collector.addMatch({
        ruleId: 'technical.codec',
        kind: 'codec',
        segmentIndex: index,
        match,
        claims: new Claims({ codecs: [re.group0(match)] }),
        priority: 30,
      });
    }

    for (const match of re.finditer(_AUDIO, text)) {
      collector.addMatch({
        ruleId: 'technical.audio',
        kind: 'audio',
        segmentIndex: index,
        match,
        claims: new Claims({ audio: [re.group0(match)] }),
        priority: 30,
      });
    }

    for (const match of re.finditer(_SUBTITLE, text)) {
      const containerMatch = re.search(_SUBTITLE_CONTAINER, re.group0(match));
      collector.addMatch({
        ruleId: 'technical.subtitle',
        kind: 'subtitle',
        segmentIndex: index,
        match,
        claims: new Claims({
          subtitle: re.sub(_STRIP_SUBTITLE_CONTAINER, '', re.group0(match)),
          container: containerMatch !== null ? re.group(containerMatch, 1) : null,
        }),
        priority: containerMatch !== null ? 35 : 30,
        specificity: containerMatch !== null ? 2 : 1,
      });
    }

    for (const match of re.finditer(_CONTAINER, text)) {
      collector.addMatch({
        ruleId: 'technical.container',
        kind: 'container',
        segmentIndex: index,
        match,
        claims: new Claims({ container: re.group(match, 1) }),
        priority: 30,
      });
    }

    if (segment.enclosure === 'square') {
      const residual = cleanFragment(patternResidual(text, _TECHNICAL_PATTERNS));
      if (residual && re.fullmatch(_CJK_SUBTITLE_TAG, residual)) {
        collector.addSpan({
          ruleId: 'technical.subtitle-cjk',
          kind: 'subtitle',
          segmentIndex: index,
          start: 0,
          end: text.length,
          claims: new Claims({ subtitle: residual }),
          priority: 45,
          evidence: [],
          overlapPolicy: OverlapPolicy.SHARED,
        });
      }
      if (_DUB.test(text)) {
        collector.addSpan({
          ruleId: 'metadata.dub',
          kind: 'tag',
          segmentIndex: index,
          start: 0,
          end: text.length,
          claims: new Claims({ tags: [text.trim()] }),
          priority: 45,
          overlapPolicy: OverlapPolicy.SHARED,
        });
      }
    }

    for (const match of re.finditer(_VERSION, text)) {
      collector.addMatch({
        ruleId: 'metadata.version',
        kind: 'version',
        segmentIndex: index,
        match,
        claims: new Claims({ version: parseInt(re.group(match, 1)!, 10) }),
        priority: 20,
      });
    }

    const metadataRules: Array<[string, RegExp]> = [
      ['metadata.prefix', _PREFIX],
      ['metadata.recruitment', _RECRUIT],
      ['metadata.region', _REGION],
      ['metadata.trailing-group', _TRAILING_RELEASE_GROUP],
    ];
    for (const [ruleId, pattern] of metadataRules) {
      for (const match of re.finditer(pattern, text)) {
        collector.addMatch({
          ruleId,
          kind: 'tag',
          segmentIndex: index,
          match,
          claims: new Claims({ tags: [re.group0(match).trim()] }),
          priority: 25,
        });
      }
    }

    for (const match of re.finditer(_HASH, text)) {
      collector.addMatch({
        ruleId: 'metadata.hash',
        kind: 'tag',
        segmentIndex: index,
        match,
        claims: new Claims({ tags: [re.group0(match)] }),
        priority: 25,
      });
    }

    if (segment.enclosure === 'square' || segment.enclosure === 'round') {
      const residual = cleanFragment(patternResidual(text, _TECHNICAL_PATTERNS));
      if (['end', '生'].includes(residual.toLowerCase())) {
        collector.addSpan({
          ruleId: 'metadata.end-marker',
          kind: 'tag',
          segmentIndex: index,
          start: 0,
          end: text.length,
          claims: new Claims({ tags: [residual] }),
          priority: 25,
          overlapPolicy: OverlapPolicy.SHARED,
        });
      }
    }
  }
}

function collectMetadataEpisodeCandidates(collector: _CandidateCollector): void {
  for (let index = 0; index < collector.segments.length; index += 1) {
    const segment = collector.segments[index];
    if (segment.enclosure !== 'square') {
      continue;
    }
    const residual = patternResidual(segment.text, _TECHNICAL_PATTERNS);
    const episodeMatch =
      re.matchStart(_BARE_EPISODE, residual) ?? re.search(_TRAILING_EPISODE, residual);
    if (episodeMatch === null || isYearNumber(re.group(episodeMatch, 1)!)) {
      continue;
    }
    const start = re.start(episodeMatch, 1);
    const end =
      re.group(episodeMatch, 2) !== null
        ? re.end(episodeMatch, 2)
        : re.end(episodeMatch, 1);
    collector.addSpan({
      ruleId: 'episode.metadata-mixed',
      kind: 'episode',
      segmentIndex: index,
      start,
      end,
      claims: new Claims({
        episode: toNumber(re.group(episodeMatch, 1)!),
        version: intOrNull(re.group(episodeMatch, 2)),
      }),
      priority: 65,
      evidence: ['episode'],
      conflictTags: new Set(['ambiguous-episode']),
      preserveAsTitleOnConflict: true,
      captures: re.groups(episodeMatch),
    });
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

function insideRangeBeforeTrailingEpisode(
  text: string,
  explicitMatch: RegExpExecArray,
): boolean {
  for (const rangeMatch of re.finditer(_RANGE, text)) {
    if (
      !(
        re.start(rangeMatch) <= re.start(explicitMatch) &&
        re.end(explicitMatch) <= re.end(rangeMatch)
      )
    ) {
      continue;
    }
    if (re.finditer(_EXPLICIT_EPISODE, re.group0(rangeMatch)).length !== 2) {
      continue;
    }
    if (trailingReleaseEpisode(text.slice(re.end(rangeMatch))) !== null) {
      return true;
    }
  }
  return false;
}

function isMixedContentMetadataTail(text: string): boolean {
  let residual = text;
  for (const pattern of [
    ..._TECHNICAL_PATTERNS,
    _CJK_SUBTITLE_TAG,
    _DUB,
    _DATE,
    _YEAR,
    _FILE_SIZE,
    _HASH,
  ]) {
    residual = re.sub(pattern, ' ', residual);
  }
  residual = re.sub(_MIXED_CONTENT_TAIL_TOKEN, ' ', residual);
  residual = re.sub(_MIXED_TAIL_STRIP, '', residual);
  return !residual;
}

function reconstructTitles(
  working: _ResidualSegment[],
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
  const result = cleanFragment(text);
  return re.sub(_UNDERSCORES, ' ', result).trim();
}

function joinTitleParts(parts: string[]): string | null {
  return parts.length > 0 ? parts.join(' ').trim() : null;
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

function mixedContentCategories(manifest: string): Set<string> {
  const categories = new Set<string>();
  for (const item of manifest.split(_PLUS_SPLIT)) {
    const match = re.matchStart(_MIXED_CONTENT_NAME_AT_START, item);
    if (match === null) {
      continue;
    }
    const marker = match.groups!['name'].toLowerCase().replace(/ /g, '');
    let category: string;
    if (marker.startsWith('tv')) {
      category = 'tv';
    } else if (['sp', 'special'].includes(marker)) {
      category = 'special';
    } else if (['movie', '劇場版', '劇場', '剧场版', '剧场'].includes(marker)) {
      category = 'movie';
    } else if (['manga', '漫画', '漫畫'].includes(marker)) {
      category = 'manga';
    } else if (['novel', '小说', '小說'].includes(marker)) {
      category = 'novel';
    } else if (['music', '音乐', '音樂'].includes(marker)) {
      category = 'music';
    } else if (['other', '其他', 'extra', 'extras'].includes(marker)) {
      category = 'other';
    } else {
      category = marker;
    }
    categories.add(category);
  }
  return categories;
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
