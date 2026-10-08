/** Downloader endpoints — mirrors webui/src/api/downloader.ts. */
import { api } from './client';
import type { RenameOperation } from '@ab/types';

export interface TorrentInfo {
  hash: string;
  name: string;
  save_path: string;
  tags?: string;
  state?: string;
  progress?: number;
  size?: number;
  added_on?: number;
  [key: string]: unknown;
}

export const apiDownloader = {
  async getTorrents() {
    const { data } = await api.get<TorrentInfo[]>('api/v1/downloader/torrents', { silent: true });
    return data;
  },
  async pause(hashes: string[]) {
    const { data } = await api.post('api/v1/downloader/torrents/pause', { hashes });
    return data;
  },
  async resume(hashes: string[]) {
    const { data } = await api.post('api/v1/downloader/torrents/resume', { hashes });
    return data;
  },
  async delete(hashes: string[], deleteFiles = false) {
    const { data } = await api.post('api/v1/downloader/torrents/delete', {
      hashes,
      delete_files: deleteFiles,
    });
    return data;
  },
  async tag(hash: string, bangumiId: number) {
    const { data } = await api.post('api/v1/downloader/torrents/tag', {
      hash,
      bangumi_id: bangumiId,
    });
    return data;
  },
  async autoTag() {
    const { data } = await api.post<{
      status: boolean;
      tagged_count: number;
      unmatched_count: number;
      unmatched: Array<{ hash: string; name: string; save_path: string }>;
      msg_en: string;
      msg_zh: string;
    }>('api/v1/downloader/torrents/tag/auto');
    return data;
  },
  async getRenameConflicts() {
    const { data } = await api.get<RenameOperation[]>('api/v1/downloader/rename-conflicts');
    return data;
  },
  async retryRenameConflict(operationId: number) {
    const { data } = await api.post(`api/v1/downloader/rename-conflicts/${operationId}/retry`);
    return data;
  },
};
