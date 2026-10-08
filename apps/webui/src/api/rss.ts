/** RSS endpoints — mirrors webui/src/api/rss.ts. */
import { api } from './client';
import type { Bangumi, Movie, RSS, Torrent } from '@ab/types';

export const apiRss = {
  async getAll() {
    const { data } = await api.get<RSS[]>('api/v1/rss');
    return data;
  },
  async add(rss: Partial<RSS>) {
    const { data } = await api.post('api/v1/rss/add', rss);
    return data;
  },
  async enableMany(ids: number[]) {
    const { data } = await api.post('api/v1/rss/enable/many', ids);
    return data;
  },
  async delete(id: number) {
    const { data } = await api.delete(`api/v1/rss/delete/${id}`);
    return data;
  },
  async deleteMany(ids: number[]) {
    const { data } = await api.post('api/v1/rss/delete/many', ids);
    return data;
  },
  async disable(id: number) {
    const { data } = await api.patch(`api/v1/rss/disable/${id}`);
    return data;
  },
  async disableMany(ids: number[]) {
    const { data } = await api.post('api/v1/rss/disable/many', ids);
    return data;
  },
  async update(id: number, payload: Partial<RSS>) {
    const { data } = await api.patch(`api/v1/rss/update/${id}`, payload);
    return data;
  },
  async refreshAll() {
    const { data } = await api.post('api/v1/rss/refresh/all');
    return data;
  },
  async refresh(id: number) {
    const { data } = await api.post(`api/v1/rss/refresh/${id}`);
    return data;
  },
  async getTorrents(id: number) {
    const { data } = await api.get<Torrent[]>(`api/v1/rss/torrent/${id}`);
    return data;
  },
  async analysis(rssLink: string, parser = 'mikan') {
    const { data } = await api.post<Bangumi | Movie>('api/v1/rss/analysis', {
      url: rssLink,
      // Vue 原版发整个 RSS 对象——parser 决定后端的官方标题/海报补全路径
      parser,
    });
    return data;
  },
  async collect(bangumi: Partial<Bangumi>) {
    const { data } = await api.post('api/v1/rss/collect', bangumi);
    return data;
  },
  async subscribe(bangumi: Partial<Bangumi>, site: string) {
    const { data } = await api.post('api/v1/rss/subscribe', {
      ...bangumi,
      parser: site,
    });
    return data;
  },
};
