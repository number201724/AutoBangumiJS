/** Bangumi rule endpoints — mirrors webui/src/api/bangumi.ts. */
import { api } from './client';
import type { Bangumi, Torrent } from '@ab/types';

export const apiBangumi = {
  async getAll() {
    const { data } = await api.get<Bangumi[]>('api/v1/bangumi/get/all');
    return data;
  },
  async get(id: number) {
    const { data } = await api.get<Bangumi>(`api/v1/bangumi/get/${id}`);
    return data;
  },
  async update(id: number, payload: Partial<Bangumi>) {
    const { data } = await api.patch(`api/v1/bangumi/update/${id}`, payload);
    return data;
  },
  async deleteMany(ids: number[], file = false) {
    const { data } = await api.post(`api/v1/bangumi/delete/many?file=${file}`, ids);
    return data;
  },
  async delete(id: number, file = false) {
    const { data } = await api.delete(`api/v1/bangumi/delete/${id}?file=${file}`);
    return data;
  },
  async disableMany(ids: number[], file = false) {
    const { data } = await api.post(`api/v1/bangumi/disable/many?file=${file}`, ids);
    return data;
  },
  async disable(id: number, file = false) {
    const { data } = await api.post(`api/v1/bangumi/disable/${id}?file=${file}`);
    return data;
  },
  async enable(id: number) {
    const { data } = await api.post(`api/v1/bangumi/enable/${id}`);
    return data;
  },
  async refreshPosterAll() {
    const { data } = await api.get('api/v1/bangumi/refresh/poster/all');
    return data;
  },
  async refreshPoster(id: number) {
    const { data } = await api.get(`api/v1/bangumi/refresh/poster/${id}`);
    return data;
  },
  async refreshCalendar() {
    const { data } = await api.get('api/v1/bangumi/refresh/calendar');
    return data;
  },
  async resetAll() {
    const { data } = await api.post('api/v1/bangumi/reset/all');
    return data;
  },
  async archive(id: number) {
    const { data } = await api.patch(`api/v1/bangumi/archive/${id}`);
    return data;
  },
  async unarchive(id: number) {
    const { data } = await api.patch(`api/v1/bangumi/unarchive/${id}`);
    return data;
  },
  async refreshMetadata() {
    const { data } = await api.get('api/v1/bangumi/refresh/metadata');
    return data;
  },
  async suggestOffset(id: number) {
    const { data } = await api.get<{ suggested_offset: number; reason: string }>(
      `api/v1/bangumi/suggest-offset/${id}`,
    );
    return data;
  },
  async detectOffset(title: string, parsedSeason: number, parsedEpisode: number) {
    const { data } = await api.post('api/v1/bangumi/detect-offset', {
      title,
      parsed_season: parsedSeason,
      parsed_episode: parsedEpisode,
    });
    return data as {
      has_mismatch: boolean;
      suggestion: {
        season_offset: number;
        episode_offset: number;
        reason: string;
        confidence: 'high' | 'medium' | 'low';
      } | null;
      tmdb_info: {
        title: string;
        total_seasons: number;
        season_episode_counts: Record<string, number>;
        status: string | null;
        virtual_season_starts: Record<string, number[]> | null;
      } | null;
    };
  },
  async dismissReview(id: number) {
    const { data } = await api.post(`api/v1/bangumi/dismiss-review/${id}`);
    return data;
  },
  async applyOffsetMany(ids: number[]) {
    const { data } = await api.post('api/v1/bangumi/apply-offset/many', ids);
    return data;
  },
  async applyOffset(id: number) {
    const { data } = await api.post(`api/v1/bangumi/apply-offset/${id}`);
    return data;
  },
  async needsReview() {
    const { data } = await api.get<Bangumi[]>('api/v1/bangumi/needs-review');
    return data;
  },
  async setWeekday(id: number, weekday: number | null) {
    const { data } = await api.patch(`api/v1/bangumi/${id}/weekday`, { weekday });
    return data;
  },
  async getOrphans() {
    const { data } = await api.get<Torrent[]>('api/v1/bangumi/torrents/orphans');
    return data;
  },
  async getOrphanCount() {
    const { data } = await api.get<number>('api/v1/bangumi/torrents/orphans/count');
    return data;
  },
  async deleteOrphans() {
    const { data } = await api.delete('api/v1/bangumi/torrents/orphans');
    return data;
  },
  async deleteOrphan(torrentId: number) {
    const { data } = await api.delete(`api/v1/bangumi/torrents/orphans/${torrentId}`);
    return data;
  },
  async getTorrents(id: number) {
    const { data } = await api.get<Torrent[]>(`api/v1/bangumi/${id}/torrents`);
    return data;
  },
  async deleteTorrents(id: number) {
    const { data } = await api.delete(`api/v1/bangumi/${id}/torrents`);
    return data;
  },
  async deleteTorrent(id: number, torrentId: number) {
    const { data } = await api.delete(`api/v1/bangumi/${id}/torrents/${torrentId}`);
    return data;
  },
};
