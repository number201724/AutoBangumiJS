/** Downloader store — mirrors webui/src/store/downloader.ts (zustand port). */
import { create } from 'zustand';
import { message } from 'antd';

import { apiDownloader, type TorrentInfo } from '@/api/downloader';
import { msgZh } from '@/utils/response';

interface DownloaderState {
  torrents: TorrentInfo[];
  selectedHashes: string[];
  loading: boolean;

  getAll: () => Promise<void>;
  setSelectedHashes: (hashes: string[]) => void;
  clearSelection: () => void;
  pauseSelected: () => Promise<void>;
  resumeSelected: () => Promise<void>;
  deleteSelected: (deleteFiles: boolean) => Promise<void>;
}

export const useDownloaderStore = create<DownloaderState>((set, get) => ({
  torrents: [],
  selectedHashes: [],
  loading: false,

  getAll: async () => {
    set({ loading: true });
    try {
      const torrents = await apiDownloader.getTorrents();
      set({ torrents });
    } catch {
      // 轮询失败（如后端重启）保留上次列表，避免页面闪成“无种子”假状态
    } finally {
      set({ loading: false });
    }
  },

  setSelectedHashes: (hashes) => set({ selectedHashes: hashes }),

  clearSelection: () => set({ selectedHashes: [] }),

  pauseSelected: async () => {
    const res = await apiDownloader.pause(get().selectedHashes);
    void message.success(msgZh(res, '种子已暂停'));
    set({ selectedHashes: [] });
    await get().getAll();
  },

  resumeSelected: async () => {
    const res = await apiDownloader.resume(get().selectedHashes);
    void message.success(msgZh(res, '种子已恢复'));
    set({ selectedHashes: [] });
    await get().getAll();
  },

  deleteSelected: async (deleteFiles) => {
    const res = await apiDownloader.delete(get().selectedHashes, deleteFiles);
    void message.success(msgZh(res, '种子已删除'));
    set({ selectedHashes: [] });
    await get().getAll();
  },
}));
