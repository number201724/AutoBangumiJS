/**
 * Offset detector for detecting season/episode mismatches with TMDB data.
 * 1:1 移植 module/parser/analyser/offset_detector.py。
 */
import { Logger } from '@nestjs/common';

import type { TMDBInfo } from './tmdb-parser';

const logger = new Logger('OffsetDetector');

/** Suggested offsets to align RSS parsed data with TMDB. */
export interface OffsetSuggestion {
  season_offset: number;
  /** null means no episode offset needed */
  episode_offset: number | null;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Detect if there's a mismatch between parsed season/episode and TMDB data.
 *
 * Uses air date gaps to detect "virtual seasons" - when TMDB has 1 season but
 * subtitle groups split it into S1/S2 based on broadcast breaks (>6 months gap).
 *
 * Note:
 *     When only season_offset is needed (simple season mismatch), episode_offset
 *     will be None. Episode offset is only set when there's a virtual season split
 *     where episodes need to be renumbered (e.g., RSS S2E01 → TMDB S1E25).
 */
export function detectOffsetMismatch(
  parsedSeason: number,
  parsedEpisode: number,
  tmdbInfo: TMDBInfo | null,
): OffsetSuggestion | null {
  if (!tmdbInfo || !tmdbInfo.last_season) {
    return null;
  }

  let suggestedSeasonOffset = 0;
  let suggestedEpisodeOffset: number | null = null; // Only set when virtual season detected
  const reasons: string[] = [];
  let confidence: 'high' | 'medium' | 'low' = 'high';

  // Check season mismatch
  // If parsed season exceeds TMDB's total seasons, suggest mapping to last season
  if (parsedSeason > tmdbInfo.last_season) {
    suggestedSeasonOffset = tmdbInfo.last_season - parsedSeason;
    const targetSeason = parsedSeason + suggestedSeasonOffset;

    // Check if this season has virtual season breakpoints (detected from air date gaps)
    if (tmdbInfo.virtual_season_starts && targetSeason in tmdbInfo.virtual_season_starts) {
      const vsStarts = tmdbInfo.virtual_season_starts[targetSeason];
      // Calculate which virtual season the parsed_season maps to
      // e.g., if vs_starts = [1, 29] and parsed_season = 2, we're in the 2nd virtual season
      const virtualSeasonIndex = parsedSeason - targetSeason; // 0-indexed from target

      if (virtualSeasonIndex > 0 && virtualSeasonIndex < vsStarts.length) {
        // Only set episode offset for 2nd+ virtual season (index > 0)
        // First virtual season (index 0) starts at episode 1, no offset needed
        suggestedEpisodeOffset = vsStarts[virtualSeasonIndex] - 1;
        reasons.push(
          `RSS显示S${parsedSeason}，但TMDB只有${tmdbInfo.last_season}季` +
            `（检测到第${virtualSeasonIndex + 1}部分从第${vsStarts[virtualSeasonIndex]}集开始，` +
            `建议集数偏移+${suggestedEpisodeOffset}）`,
        );
        logger.debug(
          `Virtual season detected: S${parsedSeason} maps to ` +
            `TMDB S${targetSeason} starting at episode ${vsStarts[virtualSeasonIndex]}`,
        );
      } else {
        // Simple season mismatch, no episode offset needed
        reasons.push(
          `RSS显示S${parsedSeason}，但TMDB只有${tmdbInfo.last_season}季` +
            `（建议季度偏移${suggestedSeasonOffset}，无需调整集数）`,
        );
      }
    } else {
      // Simple season mismatch, no episode offset needed
      reasons.push(
        `RSS显示S${parsedSeason}，但TMDB只有${tmdbInfo.last_season}季` +
          `（建议季度偏移${suggestedSeasonOffset}，无需调整集数）`,
      );
    }

    logger.debug(
      `Season mismatch: parsed S${parsedSeason}, ` +
        `TMDB has ${tmdbInfo.last_season} seasons, suggesting offset ${suggestedSeasonOffset}`,
    );
  }

  // Check episode range for target season
  const targetSeason = parsedSeason + suggestedSeasonOffset;
  if (tmdbInfo.season_episode_counts) {
    const seasonEpCount = tmdbInfo.season_episode_counts[targetSeason] ?? 0;
    const adjustedEpisode = parsedEpisode + (suggestedEpisodeOffset ?? 0);

    if (seasonEpCount > 0 && adjustedEpisode > seasonEpCount) {
      // Episode exceeds the count for this season
      if (tmdbInfo.series_status === 'Returning Series') {
        confidence = 'medium';
        reasons.push(
          `调整后集数${adjustedEpisode}超出TMDB该季的${seasonEpCount}集` +
            `（正在放送中，TMDB可能未更新）`,
        );
      } else {
        reasons.push(`调整后集数${adjustedEpisode}超出TMDB该季的${seasonEpCount}集`);
      }

      logger.debug(
        `Episode range issue: adjusted E${adjustedEpisode}, ` +
          `TMDB S${targetSeason} has ${seasonEpCount} episodes`,
      );
    }
  }

  // Only return suggestion if there's actually a mismatch
  if (reasons.length > 0) {
    return {
      season_offset: suggestedSeasonOffset,
      episode_offset: suggestedEpisodeOffset,
      reason: reasons.join('; '),
      confidence,
    };
  }

  return null;
}
