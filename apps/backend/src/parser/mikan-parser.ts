/**
 * Mikan 番剧主页 HTML 抓取 —— 1:1 移植 module/parser/analyser/mikan_parser.py。
 *
 * bangumi-poster style 的海报 URL + bangumi-title 文本去"第X季"；
 * 有界缓存 512（插入序淘汰）。BeautifulSoup → cheerio。
 */
import * as cheerio from 'cheerio';

import { RequestContent } from '../network/request-contents';
import { saveImage } from '../utils/cache-image';
import { LruCache } from './lru-cache';

// In-memory cache for Mikan homepage lookups. Keyed by per-episode homepage
// URL, so it is bounded (LRU-ish, oldest-evicted) rather than unlimited.
const MIKAN_CACHE_MAX = 512;
const mikanCache = new LruCache<string, [string, string]>(MIKAN_CACHE_MAX, false);

/** 清空 Mikan 主页解析缓存。配置重载后必须调用，否则会继续返回旧配置下
 *  缓存的结果。 */
export function resetCache(): void {
  mikanCache.clear();
}

function cacheResult(homepage: string, result: [string, string]): [string, string] {
  mikanCache.set(homepage, result);
  return result;
}

export async function mikanParser(homepage: string): Promise<[string, string]> {
  if (mikanCache.has(homepage)) {
    return mikanCache.get(homepage)!;
  }
  const rootPath = new URL(homepage).host;
  const req = new RequestContent();
  const content = await req.getHtml(homepage);
  // get_html returns None on a failed fetch; feed BeautifulSoup an empty
  // string instead of None so a network failure surfaces as a normal
  // "element not found" AttributeError rather than an uncaught TypeError.
  const $ = cheerio.load(content ?? '');
  // .find()/.select_one() can return None (missing element); accessing
  // .get()/.text unguarded is deliberate -- see comment above -- so the
  // caller's `except AttributeError` catches a parse/network failure.
  // （TS：元素缺失时显式抛 TypeError，对齐 Python 的 AttributeError 分支。）
  const posterDiv = $('div.bangumi-poster').first();
  const titleAnchor = $('p.bangumi-title a[href^="/Home/Bangumi/"]').first();
  if (posterDiv.length === 0 || titleAnchor.length === 0) {
    throw new TypeError('Mikan homepage structure not recognized');
  }
  const posterStyle = posterDiv.attr('style');
  let officialTitle = titleAnchor.text();
  officialTitle = officialTitle.replace(/第.*季/gu, '').trim();
  if (posterStyle) {
    const posterPath = posterStyle.split("url('")[1]?.split("')")[0];
    if (posterPath === undefined) {
      throw new TypeError('Mikan poster style has no url()');
    }
    const cleanPath = posterPath.split('?')[0];
    const posterUrl = `https://${rootPath}${cleanPath}`;
    const img = await req.getContent(posterUrl);
    const suffix = cleanPath.split('.').pop()!;
    // img can be None if the poster download failed; don't crash on it.
    const posterLink = img ? ((await saveImage(img, suffix, posterUrl)) ?? '') : '';
    return cacheResult(homepage, [posterLink, officialTitle]);
  }
  return cacheResult(homepage, ['', officialTitle]);
}
