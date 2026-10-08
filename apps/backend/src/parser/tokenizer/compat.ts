/** Compatibility projection from generic tokenizer results to ``Episode``. */

import {
  Episode,
  MediaType,
  ParsedRelease,
  ReleaseKind,
  makeEpisode,
  primaryTitle,
} from '../types';
import { parseReleaseTitle } from './parser';

const SPECIAL_MEDIA = new Set<MediaType>([MediaType.OVA, MediaType.OAD, MediaType.SPECIAL]);

/**
 * Project a generic result onto the historical parser contract.
 *
 * The old API is intentionally conservative: a plain title with neither an
 * episode nor a strong resource-kind marker remains unparseable.  New callers
 * should use :func:`parse_release_title` to receive such partial results.
 */
export function toLegacyEpisode(parsed: ParsedRelease): Episode | null {
  if (!primaryTitle(parsed)) {
    return null;
  }
  if (parsed.is_mixed_collection) {
    return null;
  }
  if (parsed.release_kind === ReleaseKind.RANGE || parsed.release_kind === ReleaseKind.BATCH) {
    return null;
  }
  if (
    parsed.media_type === MediaType.PV ||
    parsed.media_type === MediaType.OPENING ||
    parsed.media_type === MediaType.ENDING
  ) {
    return null;
  }
  if (parsed.episode !== null && !Number.isInteger(parsed.episode)) {
    return null;
  }
  if (
    parsed.episode === null &&
    parsed.media_type === MediaType.UNKNOWN &&
    parsed.release_kind !== ReleaseKind.COLLECTION
  ) {
    return null;
  }

  let episodeType: string;
  let season: number;
  if (parsed.media_type === MediaType.MOVIE) {
    episodeType = 'movie';
    season = parsed.season ?? 1;
  } else if (SPECIAL_MEDIA.has(parsed.media_type)) {
    episodeType = 'special';
    season = 0;
  } else {
    episodeType = 'episode';
    season = parsed.season ?? 1;
  }

  return makeEpisode({
    title_en: parsed.title_en,
    title_zh: parsed.title_zh,
    title_jp: parsed.title_jp,
    season,
    season_raw: parsed.season_raw || '',
    episode: parsed.episode ?? 0,
    sub: parsed.subtitle,
    group: parsed.group || '',
    resolution: parsed.resolution,
    source: parsed.source,
    episode_type: episodeType,
  });
}

/** Map a generic media type to the legacy non-episodic classifier. */
export function legacyNonEpisodicType(mediaType: MediaType): string | null {
  if (mediaType === MediaType.MOVIE) {
    return 'movie';
  }
  if (SPECIAL_MEDIA.has(mediaType)) {
    return 'special';
  }
  return null;
}

/**
 * Project the low-level Preview parser result onto the legacy contract.
 *
 * This helper intentionally does not consult ``rss_parser.engine``. Runtime
 * callers that need the configured Classic/Preview choice must use the
 * selector-aware ``module.parser.analyser.raw_parser`` compatibility entry.
 */
export function tokenizeTitle(raw: string): Episode | null {
  const parsed = parseReleaseTitle(raw);
  return parsed !== null ? toLegacyEpisode(parsed) : null;
}
