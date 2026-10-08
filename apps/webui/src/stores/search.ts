/**
 * 全局搜索 store — 镜像 Vue webui 的 pinia store/search.ts + api/search.ts：
 * EventSource SSE 状态机（CLOSED|CONNECTING|OPEN）、逐条 data 追加与去重、
 * 关闭/换词/清空时必须 close 旧流防泄漏（服务端关流后旧流会无限自动重连空转）、
 * 按 official_title 分组的 groupedResults。
 */
import { create } from 'zustand';
import type { Bangumi } from '@ab/types';

import { apiSearch } from '@/api/search';

/** SSE 连接状态（沿用原生 EventSource.readyState 的命名） */
export type SearchStatus = 'CONNECTING' | 'OPEN' | 'CLOSED';

/** SSE 逐条推送的番剧变体：filter/rss_link 已由逗号分隔字符串解析为数组（对齐 Vue BangumiRule） */
export type SearchVariant = Omit<Bangumi, 'filter' | 'rss_link'> & {
  filter: string[];
  rss_link: string[];
};

/** 后端流式条目的原始形态（filter/rss_link 为逗号分隔字符串） */
type SearchVariantAPI = Omit<Bangumi, 'filter' | 'rss_link'> & {
  filter: string | null;
  rss_link: string | null;
};

/** 按 official_title 分组的搜索结果（对应 Vue store 的 GroupedBangumi） */
export interface GroupedBangumi {
  key: string;
  official_title: string;
  poster_link: string;
  year: string | null;
  variants: SearchVariant[];
}

/** 单条流式 JSON → SearchVariant（空段丢弃，避免产生空标签） */
function parseVariant(raw: SearchVariantAPI): SearchVariant {
  return {
    ...raw,
    filter: (raw.filter ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rss_link: (raw.rss_link ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** 按 official_title（缺省回退 title_raw）分组；海报/年份取组内首个变体 */
export function groupResults(data: SearchVariant[]): GroupedBangumi[] {
  const map = new Map<string, SearchVariant[]>();
  for (const item of data) {
    const key = item.official_title || item.title_raw || '';
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  const groups: GroupedBangumi[] = [];
  for (const [key, variants] of map) {
    const first = variants[0];
    groups.push({
      key,
      official_title: first.official_title || first.title_raw || '',
      poster_link: first.poster_link || '',
      year: first.year,
      variants,
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// 变体展示归一化（移植自 Vue ab-search-modal.vue）
// ---------------------------------------------------------------------------

/** 分辨率归一化：4K/FHD/HD/SD，未识别返回原值 */
export function normalizeResolution(raw: string): string {
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.includes('4k') || lower.includes('2160') || lower.includes('uhd')) return '4K';
  if (lower.includes('1080') || lower.includes('fhd') || lower.includes('1920')) return 'FHD';
  if (lower.includes('720') || lower === 'hd') return 'HD';
  if (lower.includes('480') || lower === 'sd') return 'SD';
  return raw;
}

/** 字幕归一化：双语/简/繁/日/内嵌/外挂，未识别返回原值 */
export function normalizeSubtitle(raw: string): string {
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (
    lower.includes('双语') ||
    lower.includes('dual') ||
    (lower.includes('简') && lower.includes('繁')) ||
    (lower.includes('chs') && lower.includes('cht'))
  ) {
    return '双语';
  }
  if (lower.includes('简') || lower.includes('chs') || lower === 'sc') {
    if (lower.includes('内嵌') || lower.includes('内封')) return '简/内嵌';
    return '简';
  }
  if (lower.includes('繁') || lower.includes('cht') || lower === 'tc') {
    if (lower.includes('内嵌') || lower.includes('内封')) return '繁/内嵌';
    return '繁';
  }
  if (lower.includes('日') || lower.includes('jp') || lower.includes('ja')) return '日';
  if (lower.includes('内嵌') || lower.includes('内封')) return '内嵌';
  if (lower.includes('外挂') || lower.includes('ass') || lower.includes('srt')) return '外挂';
  return raw;
}

/** 季度归一化：S1/S2…、剧场版/OVA/SP，未识别返回原值 */
export function normalizeSeason(raw: string): string {
  if (!raw) return '';
  if (/^S\d+$/i.test(raw)) return raw.toUpperCase();
  const match = raw.match(/(\d+)/);
  if (match) return `S${match[1]}`;
  const lower = raw.toLowerCase();
  if (lower.includes('剧场') || lower.includes('movie') || lower.includes('劇場')) return '剧场版';
  if (lower.includes('ova')) return 'OVA';
  if (lower.includes('sp') || lower.includes('special')) return 'SP';
  return raw;
}

/** 变体的归一化分辨率展示值 */
export function getResolution(v: SearchVariant): string {
  return normalizeResolution(v.dpi ?? '');
}

/** 变体的归一化字幕展示值 */
export function getSubtitle(v: SearchVariant): string {
  return normalizeSubtitle(v.subtitle ?? '');
}

/** 变体的归一化季度展示值（season_raw 优先，回退 S{season}） */
export function getSeason(v: SearchVariant): string {
  if (v.season_raw) return normalizeSeason(v.season_raw);
  if (v.season) return `S${v.season}`;
  return '';
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SearchState {
  providers: string[];
  provider: string;
  keyword: string;
  status: SearchStatus;
  /** 派生自 status !== 'CLOSED'，随 status 同步维护（topbar 搜索入口直接订阅该字段） */
  loading: boolean;
  /** 连接从未建立（鉴权/服务端/网络问题）才算失败；正常流结束触发的 onerror 不算 */
  searchFailed: boolean;
  data: SearchVariant[];
  showModal: boolean;
  selectedResult: SearchVariant | null;

  getProviders: () => Promise<void>;
  setKeyword: (v: string) => void;
  setProvider: (p: string) => void;
  openModal: () => void;
  closeModal: () => void;
  toggleModal: () => void;
  /** 建立 SSE 流（先关旧流、清空旧结果） */
  openSearch: () => void;
  closeSearch: () => void;
  /** 回车/点击搜索：空关键词直接忽略 */
  onSearch: () => void;
  /** 清空关键词与结果并关流 */
  clearSearch: () => void;
  selectResult: (b: SearchVariant | null) => void;
  /** 派生：按 official_title 分组（纯计算；组件侧配合 data 订阅 + useMemo 使用） */
  groupedResults: () => GroupedBangumi[];
}

/**
 * 当前 SSE 流实例：放 store 状态外（对应 Vue 的 shallowRef——
 * 进响应式会被包成代理，`eventSource !== es` 的同流判定永远为真）
 */
let eventSource: EventSource | null = null;

export const useSearchStore = create<SearchState>((set, get) => {
  const closeStream = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
      set({ status: 'CLOSED', loading: false });
    }
  };

  const initStream = () => {
    const { provider, keyword } = get();
    set({ status: 'CONNECTING', loading: true });
    // 同域相对路径，withCredentials 默认无需配置
    const es = new EventSource(apiSearch.bangumiStreamUrl(provider, keyword));
    eventSource = es;

    es.onopen = () => {
      if (eventSource !== es) return;
      set({ status: 'OPEN', loading: true });
    };
    es.onmessage = (e) => {
      // 已被新一次搜索替换的旧流：关掉自己，不再往结果里追加
      if (eventSource !== es) {
        es.close();
        return;
      }
      const item = parseVariant(JSON.parse(e.data as string) as SearchVariantAPI);
      // 兜底去重：服务端每条流内已按订阅链接去重，这里防异常场景的重复项
      const id = item.rss_link[0] || item.title_raw;
      const { data } = get();
      if (data.some((d) => (d.rss_link[0] || d.title_raw) === id)) return;
      set({ data: [...data, item] });
    };
    es.onerror = (err) => {
      // 旧流的 onerror 绝不能碰共享状态（会把新流关掉）；但必须 close
      // 自己——不关的话浏览器会对已结束的流无限自动重连（空转）
      if (eventSource !== es) {
        es.close();
        return;
      }
      console.error('EventSource error:', err);
      // 搜索成功后服务端关流也会触发 onerror——只有连接从未 OPEN 才算失败
      if (get().status === 'CONNECTING') {
        set({ searchFailed: true });
      }
      closeStream();
    };
  };

  return {
    providers: ['mikan', 'anibt', 'dmhy', 'nyaa'],
    provider: 'mikan',
    keyword: '',
    status: 'CLOSED',
    loading: false,
    searchFailed: false,
    data: [],
    showModal: false,
    selectedResult: null,

    async getProviders() {
      const providers = await apiSearch.getProviders();
      set({ providers, provider: providers[0] ?? get().provider });
    },

    setKeyword(keyword) {
      set({ keyword });
      // 输入被清空时停掉进行中的搜索流：空输入框不该继续转圈
      if (!keyword.trim()) get().closeSearch();
    },

    setProvider: (provider) => set({ provider }),

    openModal: () => set({ showModal: true }),

    closeModal() {
      get().closeSearch();
      set({ showModal: false, selectedResult: null });
    },

    toggleModal: () => (get().showModal ? get().closeModal() : get().openModal()),

    openSearch() {
      // 先关上一条流再开新流：不关的话旧流泄漏——结果被重复追加，
      // 且服务端关闭后旧流会无限自动重连（空转）
      closeStream();
      set({ data: [], searchFailed: false });
      initStream();
    },

    closeSearch: closeStream,

    onSearch() {
      if (!get().keyword.trim()) return;
      get().openSearch();
    },

    clearSearch() {
      closeStream();
      set({ keyword: '', data: [] });
    },

    selectResult: (selectedResult) => set({ selectedResult }),

    groupedResults: () => groupResults(get().data),
  };
});
