/**
 * Offset scanner — 1:1 port of module/core/offset_scanner.py.
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { db } from '../database/facade';
import { lazyRequire } from '../utils/lazy';
import type { BangumiRow } from '../database/schema';

const logger = new Logger('OffsetScanner');

function eventsModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../notification/events') as typeof import('../notification/events');
}

interface OffsetSuggestion {
  reason: string;
  season_offset: number;
  episode_offset: number | null;
  confidence: string;
}
interface TmdbInfoLike {
  [key: string]: unknown;
}
interface ParserModulesLike {
  detectOffsetMismatch(
    parsedSeason: number,
    parsedEpisode: number,
    tmdbInfo: TmdbInfoLike | null,
  ): OffsetSuggestion | null;
  parseConfiguredReleaseTitle(title: string): { episode: number | null } | null;
  tmdbParser(title: string, language: string): Promise<TmdbInfoLike | null>;
  isOffsetSignal(release: unknown): boolean;
}
function parserModules(): ParserModulesLike {
  return {
    detectOffsetMismatch: lazyRequire<Pick<ParserModulesLike, 'detectOffsetMismatch'>>('../parser/offset-detector').detectOffsetMismatch,
    parseConfiguredReleaseTitle: lazyRequire<Pick<ParserModulesLike, 'parseConfiguredReleaseTitle'>>('../parser/selector').parseConfiguredReleaseTitle,
    tmdbParser: lazyRequire<Pick<ParserModulesLike, 'tmdbParser'>>('../parser/tmdb-parser').tmdbParser,
    isOffsetSignal: lazyRequire<Pick<ParserModulesLike, 'isOffsetSignal'>>('../parser/release-policy').isOffsetSignal,
  };
}

interface OffsetEventLike {
  official_title: string;
  reason: string;
}

/** Periodically scan bangumi for season/episode mismatches with TMDB. */
export class OffsetScanner {
  /** Scan all active bangumi; returns one event per flagged bangumi. */
  async scanAll(): Promise<OffsetEventLike[]> {
    logger.log('Starting offset scan...');

    const bangumiList = db.bangumi.getActiveForScan();
    if (!bangumiList.length) {
      logger.debug('No active bangumi to scan.');
      return [];
    }

    const events: OffsetEventLike[] = [];
    for (const b of bangumiList) {
      try {
        const event = await this.checkBangumi(b);
        if (event !== null) events.push(event);
      } catch (e) {
        logger.warn(`Error checking ${b.official_title}: ${e}`);
      }
    }

    logger.log(`Scan complete. Flagged ${events.length} bangumi for review.`);
    return events;
  }

  private async checkBangumi(b: BangumiRow): Promise<OffsetEventLike | null> {
    const { detectOffsetMismatch, tmdbParser } = parserModules();

    // Skip if already needs review
    if (b.needs_review) {
      logger.debug(`Skipping ${b.official_title}: already needs review`);
      return null;
    }

    // OVA/OAD/SP are not weekly episode streams and must never drive offsets.
    if (b.episode_type !== 'episode') {
      logger.debug(`Skipping ${b.official_title}: episode_type=${b.episode_type}`);
      return null;
    }

    // Skip if user has already configured offsets
    if (b.season_offset !== 0 || b.episode_offset !== 0) {
      logger.debug(`Skipping ${b.official_title}: has configured offsets`);
      return null;
    }

    // Get TMDB info
    const language = settings.data.rss_parser.language;
    const tmdbInfo = await tmdbParser(b.official_title, language);
    if (!tmdbInfo) {
      logger.debug(`Skipping ${b.official_title}: no TMDB info`);
      return null;
    }

    // Get the real latest parsed episode from this bangumi's torrent records.
    const parsedEpisode = await this.getLatestParsedEpisode(b.id);
    if (parsedEpisode === null) {
      logger.debug(`Skipping ${b.official_title}: no parsed episode data`);
      return null;
    }

    // Detect mismatch
    const suggestion = detectOffsetMismatch(b.season, parsedEpisode, tmdbInfo);

    if (suggestion && (suggestion.confidence === 'high' || suggestion.confidence === 'medium')) {
      db.bangumi.setNeedsReview(
        b.id,
        suggestion.reason,
        suggestion.season_offset,
        suggestion.episode_offset,
      );
      logger.log(
        `Flagged ${b.official_title} for review: ${suggestion.reason} ` +
          `(suggested: season=${suggestion.season_offset}, episode=${suggestion.episode_offset})`,
      );
      const { OffsetReviewEvent } = eventsModule();
      return new OffsetReviewEvent(b.official_title, suggestion.reason) as OffsetEventLike;
    }
    return null;
  }

  /** 从 Torrent 表解析该番剧已知的最新集数，作为真实信号使用。 */
  private async getLatestParsedEpisode(bangumiId: number): Promise<number | null> {
    const { parseConfiguredReleaseTitle, isOffsetSignal } = parserModules();
    const torrents = db.torrent.searchByBangumiId(bangumiId);

    let latest: number | null = null;
    for (const t of torrents) {
      const release = parseConfiguredReleaseTitle(t.name);
      if (release === null || !isOffsetSignal(release)) continue;
      const episode = release.episode;
      // is_offset_signal guarantees an int episode; keep the guard for narrowing
      if (typeof episode !== 'number' || !Number.isInteger(episode)) continue;
      if (latest === null || episode > latest) latest = episode;
    }
    return latest;
  }

  /** Check a single bangumi by ID. True if flagged for review. */
  async checkSingle(bangumiId: number): Promise<boolean> {
    const b = db.bangumi.searchId(bangumiId);
    if (!b) {
      logger.warn(`Bangumi ${bangumiId} not found`);
      return false;
    }
    return (await this.checkBangumi(b)) !== null;
  }
}
