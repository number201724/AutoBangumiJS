/**
 * Search provider URL assembly — 1:1 port of module/searcher/provider.py.
 */
import { getProvider } from '../config/search-provider';
import type { RssRow } from '../database/schema';

export function searchUrl(site: string, keywords: string[]): RssRow {
  const keyword = keywords.join('+');
  // Python re.sub(r"[\W_ ]", "+", ...)：\W 是 Unicode 感知（保留中日韩文字，
  // 替换标点/空白/下划线）。JS 等价：Unicode property escapes + u flag，
  // 否则 CJK 会被整串替换（"无职转生" → "++++"）。
  const searchStr = keyword.replace(/[^\p{L}\p{N}]/gu, '+');
  const providers = getProvider();
  if (site in providers) {
    // 模板是字面 "%s" 占位符（str.replace，非正则）
    const url = providers[site].url.split('%s').join(searchStr);
    return {
      id: 0,
      name: null,
      url,
      aggregate: false,
      parser: providers[site].parser,
      enabled: true,
      connection_status: null,
      last_checked_at: null,
      last_error: null,
    };
  }
  throw new Error(`Site ${site} is not supported`);
}
