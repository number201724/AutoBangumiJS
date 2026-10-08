/**
 * 番剧页/放送日历共用的纯工具：分组、海报地址、星期文案。
 * 对应 Vue 版的 groupBangumi、utils/poster.ts 与 i18n calendar.days。
 */
import type { Bangumi } from '@ab/types';

/** 按 official_title + season 分组后的番剧组，番剧主页/日历共用 */
export interface BangumiGroup {
  key: string;
  primary: Bangumi;
  rules: Bangumi[];
}

/** 与 Vue 版一致：同一 official_title + season 的多条规则合并为一张卡片 */
export function groupBangumi(items: Bangumi[]): BangumiGroup[] {
  if (!items) return [];
  const map = new Map<string, Bangumi[]>();
  for (const item of items) {
    const key = `${item.official_title}::${item.season}`;
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  const groups: BangumiGroup[] = [];
  for (const [key, rules] of map) {
    groups.push({ key, primary: rules[0], rules });
  }
  return groups;
}

/** 海报地址：后端返回相对路径时补前导斜杠（对应 Vue resolvePosterUrl） */
export function resolvePosterUrl(link: string | null | undefined): string {
  if (!link) return '';
  if (link.startsWith('http://') || link.startsWith('https://')) return link;
  return `/${link}`;
}

/** air_weekday: 0=周一 ... 6=周日 */
export const WEEKDAY_FULL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;
export const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'] as const;

/** 今天对应的 air_weekday 下标（JS getDay: 0=周日 → 6） */
export function todayWeekdayIndex(): number {
  const jsDay = new Date().getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

/** filter 字段在后端是逗号分隔字符串，表单里按标签数组编辑 */
export function filterToTags(filter: string | null | undefined): string[] {
  if (!filter) return [];
  return filter
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function tagsToFilter(tags: string[]): string {
  return tags.join(',');
}

/** 组内是否有需要检查的规则（警告角标） */
export function groupNeedsReview(group: BangumiGroup): boolean {
  return group.rules.some((r) => r.needs_review);
}

/** 变更类接口的返回体里带 msg_zh，优先使用 */
export function msgOf(res: unknown, fallback: string): string {
  if (res && typeof res === 'object' && 'msg_zh' in res) {
    const m = (res as { msg_zh?: unknown }).msg_zh;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}
