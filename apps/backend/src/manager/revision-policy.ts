/**
 * Revision-replacement admission — 1:1 port of manager/revision_policy.py (#1078).
 */
import { MediaType } from '../parser/types';
import { lazyRequire } from '../utils/lazy';

export interface RevisionIdentity {
  bangumi_id: number;
  media_type: MediaType;
  season: number;
  episode: number;
  group: string;
  resolution: string;
  revision: number;
}

function parserSelector() {
  return lazyRequire<{
    parseConfiguredReleaseTitle(title: string): {
      group: string | null;
      resolution: string | null;
      [key: string]: unknown;
    } | null;
  }>('../parser/selector');
}
function releasePolicy() {
  return lazyRequire<{
    preferenceIdentity(
      release: unknown,
      defaultSeason: number,
    ): [MediaType, number, number] | null;
    preferenceRevision(release: unknown): number;
  }>('../parser/release-policy');
}

/** NFKC + casefold + strip non-word chars (Python unicodedata NFKC). */
function normalizeLabel(value: string | null | undefined): string {
  if (!value) return '';
  const normalized = value.normalize('NFKC').toLowerCase();
  // Python \w matches unicode word chars; JS needs the u flag
  return normalized.replace(/[^\p{L}\p{N}_]+/gu, '');
}

/** EP0 永不偏移；非正结果回退原集数。 */
function adjustEpisode(episode: number, offset: number): number {
  if (episode === 0 && offset) return 0;
  const adjusted = episode + offset;
  if (adjusted < 0 || (adjusted === 0 && episode > 0)) return episode;
  return adjusted;
}

/** Return the strict identity required before an old file may be deleted. */
export function parseRevisionIdentity(
  torrentName: string,
  args: {
    bangumi_id: number | null;
    default_season: number;
    episode_offset?: number;
  },
): RevisionIdentity | null {
  const { bangumi_id, default_season, episode_offset = 0 } = args;
  if (bangumi_id === null) return null;
  const release = parserSelector().parseConfiguredReleaseTitle(torrentName);
  if (release === null) return null;
  const identity = releasePolicy().preferenceIdentity(release, default_season);
  if (identity === null) return null;
  const [media_type, season, episode] = identity;
  const group = normalizeLabel(release.group);
  const resolution = normalizeLabel(release.resolution);
  if (!group || !resolution) return null;
  return {
    bangumi_id,
    media_type,
    season,
    episode: adjustEpisode(episode, episode_offset),
    group,
    resolution,
    revision: releasePolicy().preferenceRevision(release),
  };
}

/** Whether two revisions describe the same strictly matched resource. */
export function sameReleaseIdentity(a: RevisionIdentity, b: RevisionIdentity): boolean {
  return (
    a.bangumi_id === b.bangumi_id &&
    a.media_type === b.media_type &&
    a.season === b.season &&
    a.episode === b.episode &&
    a.group === b.group &&
    a.resolution === b.resolution
  );
}

/** Whether `next` may destructively replace `prev`. */
export function isStrictUpgrade(prev: RevisionIdentity, next: RevisionIdentity): boolean {
  return sameReleaseIdentity(prev, next) && next.revision > prev.revision;
}

/** Build a deterministic same-directory temporary path for saga recovery. */
export function replacementStagedPath(
  targetPath: string,
  args: { old_task_id: string; old_revision: number },
): string {
  const normalized = targetPath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const parent = slash >= 0 ? normalized.slice(0, slash) : '';
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dot = name.lastIndexOf('.');
  const suffix = dot > 0 ? name.slice(dot) : '';
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  const stagedName = `${stem}.ab-replaced-v${args.old_revision}-${args.old_task_id.slice(0, 8)}${suffix}`;
  return parent ? `${parent}/${stagedName}` : stagedName;
}
