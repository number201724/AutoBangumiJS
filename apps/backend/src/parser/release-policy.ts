/**
 * Persistence-target admission policy — mirrors module/parser/release_policy.py.
 *
 * Parsing answers what a resource name contains.  These helpers answer whether a
 * particular consumer can safely use that result.  Keeping the policy outside the
 * tokenizer prevents download/database constraints from leaking into parsing.
 */
import { MediaType, ReleaseKind, primaryTitle, type ParsedRelease } from './types';

export enum PersistenceTarget {
  BANGUMI = 'bangumi',
  MOVIE = 'movie',
}

const SPECIAL_MEDIA = new Set<MediaType>([MediaType.OVA, MediaType.OAD, MediaType.SPECIAL]);
const NUMBERED_MEDIA = new Set<MediaType>([MediaType.EPISODE, ...SPECIAL_MEDIA]);
const NON_PERSISTED_MEDIA = new Set<MediaType>([
  MediaType.PV,
  MediaType.OPENING,
  MediaType.ENDING,
]);

/** Whether a title-only result still looks like an actual release name. */
export function hasReleaseEvidence(release: ParsedRelease): boolean {
  return Boolean(
    release.group ||
      release.resolution ||
      release.source ||
      release.subtitle ||
      release.codecs.length > 0 ||
      release.audio.length > 0 ||
      release.container,
  );
}

/** Whether parsing found only a title, with no release-shaped evidence. */
export function isWeakTitleOnly(release: ParsedRelease): boolean {
  return Boolean(
    primaryTitle(release) &&
      release.media_type === MediaType.UNKNOWN &&
      release.release_kind === ReleaseKind.SINGLE &&
      release.episode === null &&
      !hasReleaseEvidence(release),
  );
}

/** Return the database projection currently supported for a release. */
export function persistenceTarget(release: ParsedRelease): PersistenceTarget | null {
  if (
    !primaryTitle(release) ||
    release.release_kind !== ReleaseKind.SINGLE ||
    NON_PERSISTED_MEDIA.has(release.media_type)
  ) {
    return null;
  }
  if (release.media_type === MediaType.MOVIE) {
    return PersistenceTarget.MOVIE;
  }
  if (isWeakTitleOnly(release)) {
    return null;
  }
  return PersistenceTarget.BANGUMI;
}

export function bangumiEpisodeType(release: ParsedRelease): string {
  return SPECIAL_MEDIA.has(release.media_type) ? 'special' : 'episode';
}

export function normalizedSeason(release: ParsedRelease, defaultSeason = 1): number {
  if (SPECIAL_MEDIA.has(release.media_type)) {
    return 0;
  }
  return release.season ?? defaultSeason;
}

/** Return a safe identity for release-preference deduplication. */
export function preferenceIdentity(
  release: ParsedRelease,
  defaultSeason = 1,
): [MediaType, number, number] | null {
  if (
    release.release_kind !== ReleaseKind.SINGLE ||
    !NUMBERED_MEDIA.has(release.media_type) ||
    release.episode === null
  ) {
    return null;
  }
  return [
    release.media_type,
    normalizedSeason(release, defaultSeason),
    release.episode,
  ];
}

/** Rank revisions of the same content; an unmarked release is revision 1. */
export function preferenceRevision(release: ParsedRelease): number {
  return release.version ?? 1;
}

/** Whether a release is a safe weekly-episode signal for offset detection. */
export function isOffsetSignal(release: ParsedRelease): boolean {
  return Boolean(
    release.media_type === MediaType.EPISODE &&
      release.release_kind === ReleaseKind.SINGLE &&
      release.episode !== null &&
      // Python 的 `type(episode) is int`：排除 12.5 之类的浮点集
      Number.isInteger(release.episode) &&
      release.episode > 0,
  );
}

/** Re-export for consumers that mirror the Python import surface. */
export { MediaType, ReleaseKind };
