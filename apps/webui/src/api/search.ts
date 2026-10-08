/** Search endpoints — mirrors webui/src/api/search.ts. */
import { api } from './client';

export const apiSearch = {
  async getProviders() {
    const { data } = await api.get<string[]>('api/v1/search/provider');
    return data;
  },
  async getProviderConfig() {
    const { data } = await api.get<Record<string, string>>('api/v1/search/provider/config');
    return data;
  },
  async updateProviderConfig(providers: Record<string, string>) {
    const { data } = await api.put<Record<string, string>>('api/v1/search/provider/config', providers);
    return data;
  },
  /** SSE search URL (EventSource cannot use axios headers/credentials config). */
  bangumiStreamUrl(site: string, keywords: string) {
    return `api/v1/search/bangumi?site=${encodeURIComponent(site)}&keywords=${encodeURIComponent(keywords)}`;
  },
};
