/**
 * bgm.tv /calendar 放送表抓取 + 标题匹配星期 ——
 * 1:1 移植 module/parser/analyser/bgm_calendar.py。
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { RequestContent } from '../network/request-contents';

const logger = new Logger('BgmCalendar');

export interface BgmCalendarItem {
  /** Japanese title */
  name: string;
  /** Chinese title */
  name_cn: string;
  /** 0=Mon, ..., 6=Sun */
  air_weekday: number;
}

interface BgmCalendarDayGroup {
  weekday?: { id?: number | null };
  items?: Array<{ name?: string | null; name_cn?: string | null }>;
}

/**
 * Fetch the current season's broadcast calendar from Bangumi.tv API.
 *
 * Returns a flat list of anime items with their air_weekday (0=Mon, ..., 6=Sun).
 * The base URL is configurable so users behind a GFW can use a mirror (#1040).
 */
export async function fetchBgmCalendar(): Promise<BgmCalendarItem[]> {
  const calendarUrl = `${settings.data.network.bgm_base_url.replace(/\/+$/, '')}/calendar`;
  const req = new RequestContent();
  const data = await req.getJson<BgmCalendarDayGroup[]>(calendarUrl);

  if (!data) {
    logger.warn('Failed to fetch calendar data.');
    return [];
  }

  const items: BgmCalendarItem[] = [];
  for (const dayGroup of data) {
    const weekdayInfo = dayGroup.weekday ?? {};
    // Bangumi.tv uses 1=Mon, 2=Tue, ..., 7=Sun
    // Convert to 0=Mon, 1=Tue, ..., 6=Sun
    const bgmWeekday = weekdayInfo.id;
    if (bgmWeekday === null || bgmWeekday === undefined) {
      continue;
    }
    const weekday = bgmWeekday - 1; // 1-7 → 0-6

    for (const item of dayGroup.items ?? []) {
      items.push({
        name: item.name ?? '',
        name_cn: item.name_cn ?? '',
        air_weekday: weekday,
      });
    }
  }

  logger.log(`Fetched ${items.length} airing anime from Bangumi.tv.`);
  return items;
}

/**
 * Match a bangumi against calendar items to find its air weekday.
 *
 * Matching strategy:
 * 1. Exact match on Chinese title (name_cn == official_title)
 * 2. Exact match on Japanese title (name == title_raw or official_title)
 * 3. Substring match (name_cn in official_title or vice versa)
 * 4. Substring match on Japanese title
 */
export function matchWeekday(
  officialTitle: string,
  titleRaw: string,
  calendarItems: BgmCalendarItem[],
): number | null {
  const officialTitleClean = officialTitle.trim();
  const titleRawClean = titleRaw.trim();

  for (const item of calendarItems) {
    const nameCn = item.name_cn.trim();
    const name = item.name.trim();

    if (!nameCn && !name) {
      continue;
    }

    // Exact match on Chinese title
    if (nameCn && nameCn === officialTitleClean) {
      return item.air_weekday;
    }

    // Exact match on Japanese/original title
    if (name && (name === titleRawClean || name === officialTitleClean)) {
      return item.air_weekday;
    }
  }

  // Second pass: substring matching
  for (const item of calendarItems) {
    const nameCn = item.name_cn.trim();
    const name = item.name.trim();

    if (!nameCn && !name) {
      continue;
    }

    // Chinese title substring (at least 4 chars to avoid false positives)
    if (nameCn && nameCn.length >= 4) {
      if (officialTitleClean.includes(nameCn) || nameCn.includes(officialTitleClean)) {
        return item.air_weekday;
      }
    }

    // Japanese title substring
    if (name && name.length >= 4) {
      if (titleRawClean.includes(name) || name.includes(titleRawClean)) {
        return item.air_weekday;
      }
    }
  }

  return null;
}
