/**
 * Parsed release title — mirrors module/parser/analyser/tokenizer/result.py,
 * plus the legacy Episode contract and the parser-level Bangumi/Movie
 * projections (module/models/bangumi.py, module/models/movie.py,
 * module/models/torrent.py).
 */
export enum MediaType {
  UNKNOWN = 'unknown',
  EPISODE = 'episode',
  MOVIE = 'movie',
  OVA = 'ova',
  OAD = 'oad',
  SPECIAL = 'special',
  PV = 'pv',
  OPENING = 'opening',
  ENDING = 'ending',
}

export enum ReleaseKind {
  SINGLE = 'single',
  RANGE = 'range',
  BATCH = 'batch',
  COLLECTION = 'collection',
}

export interface ParsedRelease {
  raw: string;
  title_en: string | null;
  title_zh: string | null;
  title_jp: string | null;
  group: string | null;
  season: number | null;
  season_raw: string | null;
  episode: number | null;
  episode_end: number | null;
  episode_title: string | null;
  media_type: MediaType;
  release_kind: ReleaseKind;
  resolution: string | null;
  source: string | null;
  subtitle: string | null;
  codecs: string[];
  audio: string[];
  container: string | null;
  version: number | null;
  year: number | null;
  tags: string[];
  evidence: string[];
  /** True when the release is a mixed multi-title collection. */
  is_mixed_collection: boolean;
}

/** ParsedRelease.primary_title（dataclass property）. */
export function primaryTitle(release: ParsedRelease): string | null {
  return release.title_en || release.title_zh || release.title_jp;
}

/** ParsedRelease.is_mixed_collection（dataclass property 的计算规则）. */
export function computeIsMixedCollection(
  mediaType: MediaType,
  releaseKind: ReleaseKind,
): boolean {
  return mediaType === MediaType.UNKNOWN && releaseKind === ReleaseKind.COLLECTION;
}

/**
 * 以 Python dataclass 默认值构造 ParsedRelease（缺省字段 = None/空 tuple/
 * UNKNOWN/SINGLE），is_mixed_collection 按 property 规则计算。
 */
export function makeParsedRelease(
  init: Partial<ParsedRelease> & { raw: string },
): ParsedRelease {
  const mediaType = init.media_type ?? MediaType.UNKNOWN;
  const releaseKind = init.release_kind ?? ReleaseKind.SINGLE;
  return {
    title_en: null,
    title_zh: null,
    title_jp: null,
    group: null,
    season: null,
    season_raw: null,
    episode: null,
    episode_end: null,
    episode_title: null,
    resolution: null,
    source: null,
    subtitle: null,
    codecs: [],
    audio: [],
    container: null,
    version: null,
    year: null,
    tags: [],
    evidence: [],
    ...init,
    media_type: mediaType,
    release_kind: releaseKind,
    is_mixed_collection:
      init.is_mixed_collection ?? computeIsMixedCollection(mediaType, releaseKind),
  };
}

/** Legacy Episode contract (module/models/bangumi.py @dataclass Episode). */
export interface Episode {
  title_en: string | null;
  title_zh: string | null;
  title_jp: string | null;
  season: number;
  season_raw: string;
  episode: number;
  sub: string | null;
  group: string;
  resolution: string | null;
  source: string | null;
  episode_type: string;
  is_movie: boolean;
}

/** Episode.__post_init__：保持 is_movie 与 episode_type 同步。 */
export function makeEpisode(
  init: Omit<Episode, 'is_movie'> & { is_movie?: boolean },
): Episode {
  let isMovie = init.is_movie ?? false;
  let episodeType = init.episode_type;
  if (isMovie) {
    episodeType = 'movie';
  } else if (episodeType === 'movie') {
    isMovie = true;
  }
  return { ...init, episode_type: episodeType, is_movie: isMovie };
}

/**
 * TitleParser 的 Bangumi 投影（module/models/bangumi.py Bangumi 中由
 * _release_to_bangumi 填充的字段；其余列级默认值由数据库层补齐）。
 */
export interface Bangumi {
  official_title: string;
  title_raw: string;
  year: string | null;
  season: number;
  season_raw: string | null;
  group_name: string;
  dpi: string | null;
  source: string | null;
  subtitle: string | null;
  eps_collect: boolean;
  episode_offset: number;
  filter: string;
  episode_type: string;
}

/** TitleParser 的 Movie 投影（module/models/movie.py Movie）。 */
export interface Movie {
  official_title: string;
  title_raw: string;
  year: number | null;
  group_name: string;
  dpi: string | null;
  source: string | null;
  subtitle: string | null;
  filter: string;
}

/** module/models/torrent.py EpisodeFile（pydantic 会把 "01" 转成 1）。 */
export interface EpisodeFile {
  media_path: string;
  group: string | null;
  title: string;
  season: number;
  episode: number;
  suffix: string;
  episode_type: string;
}

/** module/models/torrent.py SubtitleFile（language 必填 zh/zh-tw）。 */
export interface SubtitleFile {
  media_path: string;
  group: string | null;
  title: string;
  season: number;
  episode: number;
  language: string;
  suffix: string;
  episode_type: string;
}
