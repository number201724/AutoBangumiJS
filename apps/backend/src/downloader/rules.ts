/**
 * Build qBittorrent RSS auto-download rule definitions from a Bangumi entry —
 * 1:1 port of module/downloader/rules.py.
 */

/** build_rss_rule 所需的最小字段（Bangumi | BangumiUpdate 的子集）。 */
export interface RssRuleData {
  title_raw: string;
  /** Python 侧是 str，但 update API 可能塞入 list，两者都接受。 */
  filter: string | string[];
  rss_link: string | string[];
}

/**
 * Construct the qB ``rss/setRule`` payload for one bangumi entry.
 *
 * ``rss_link`` is normalised to a comma-joined string when a list slips in
 * from the update API. ``save_path`` is passed explicitly because the two
 * call sites source it differently (the freshly generated path vs. the moved
 * location).
 */
export function buildRssRule(data: RssRuleData, savePath: string): Record<string, unknown> {
  const affectedFeeds =
    typeof data.rss_link === 'string' ? data.rss_link : data.rss_link.join(',');
  // filter is a comma-separated string of regex terms; qB wants them as a
  // single alternation. join() would split the string into characters
  // ("720,480" -> "7|2|0|,|4|8|0"); replace keeps whole terms ("720|480").
  const mustNotContain =
    typeof data.filter === 'string'
      ? data.filter.split(',').join('|')
      : data.filter.join('|');
  return {
    enable: true,
    mustContain: data.title_raw,
    mustNotContain,
    useRegex: true,
    episodeFilter: '',
    smartFilter: false,
    previouslyMatchedEpisodes: [],
    affectedFeeds,
    ignoreDays: 0,
    lastMatch: '',
    addPaused: false,
    assignedCategory: 'Bangumi',
    savePath,
  };
}
