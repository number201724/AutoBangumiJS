/**
 * 旧 Episode 契约兼容层 —— 1:1 移植 module/parser/analyser/raw_parser.py。
 */
import { Logger } from '@nestjs/common';

import type { Episode } from './types';
import { parseConfiguredReleaseTitle } from './selector';
import { legacyNonEpisodicType, toLegacyEpisode } from './tokenizer/compat';

const logger = new Logger('RawParser');

/** Return the first square-bracket group, or an empty string. */
export function getGroup(raw: string): string {
  const parsed = parseConfiguredReleaseTitle(raw);
  return parsed !== null && parsed.group ? parsed.group : '';
}

/**
 * Classify movie/special markers for LLM results.
 *
 * The tokenizer performs the normal deterministic classification.  This
 * helper remains the compatibility seam used by ``TitleParser`` when an LLM
 * result needs its episode type corrected from the original release title.
 */
export function detectNonEpisodicType(raw: string): string | null {
  const parsed = parseConfiguredReleaseTitle(raw);
  if (parsed === null) {
    return null;
  }
  return legacyNonEpisodicType(parsed.media_type);
}

export function rawParser(raw: string): Episode | null {
  const parsed = parseConfiguredReleaseTitle(raw);
  const result = parsed !== null ? toLegacyEpisode(parsed) : null;
  if (result === null) {
    logger.log(`Cannot parse resource: ${raw}, skipping.`);
  }
  return result;
}
