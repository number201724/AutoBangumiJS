/** RSS store — mirrors webui/src/store/rss.ts (zustand port). */
import { create } from 'zustand';
import { message } from 'antd';

import { apiRss } from '@/api/rss';
import { msgZh } from '@/utils/response';
import type { RSS } from '@ab/types';

interface RssState {
  rss: RSS[];
  selectedIds: number[];
  loading: boolean;
  refreshingAll: boolean;

  getAll: () => Promise<void>;
  setSelected: (ids: number[]) => void;
  enableSelected: () => Promise<void>;
  disableSelected: () => Promise<void>;
  deleteSelected: () => Promise<void>;
  deleteOne: (id: number) => Promise<void>;
  refreshAll: () => Promise<void>;
  /** 编辑（名称 / 解析器）；成功返回 true 并刷新列表。 */
  update: (id: number, payload: Partial<RSS>) => Promise<boolean>;
}

export const useRssStore = create<RssState>((set, get) => ({
  rss: [],
  selectedIds: [],
  loading: false,
  refreshingAll: false,

  getAll: async () => {
    set({ loading: true });
    try {
      const res = await apiRss.getAll();
      const byIdDesc = (a: RSS, b: RSS) => b.id - a.id;
      const enabled = res.filter((e) => e.enabled).sort(byIdDesc);
      const disabled = res.filter((e) => !e.enabled).sort(byIdDesc);
      set({ rss: [...enabled, ...disabled] });
    } finally {
      set({ loading: false });
    }
  },

  setSelected: (ids) => set({ selectedIds: ids }),

  enableSelected: async () => {
    const res = await apiRss.enableMany(get().selectedIds);
    void message.success(msgZh(res, '已启用'));
    set({ selectedIds: [] });
    await get().getAll();
  },

  disableSelected: async () => {
    const res = await apiRss.disableMany(get().selectedIds);
    void message.success(msgZh(res, '已禁用'));
    set({ selectedIds: [] });
    await get().getAll();
  },

  deleteSelected: async () => {
    const res = await apiRss.deleteMany(get().selectedIds);
    void message.success(msgZh(res, '已删除'));
    set({ selectedIds: [] });
    await get().getAll();
  },

  deleteOne: async (id) => {
    const res = await apiRss.delete(id);
    void message.success(msgZh(res, '已删除'));
    set({ selectedIds: get().selectedIds.filter((i) => i !== id) });
    await get().getAll();
  },

  refreshAll: async () => {
    set({ refreshingAll: true });
    try {
      const res = await apiRss.refreshAll();
      void message.success(msgZh(res, '刷新成功'));
      await get().getAll();
    } finally {
      set({ refreshingAll: false });
    }
  },

  update: async (id, payload) => {
    try {
      const res = await apiRss.update(id, payload);
      void message.success(msgZh(res, '更新成功'));
      await get().getAll();
      return true;
    } catch {
      /* 错误提示由 axios 拦截器统一弹出 */
      return false;
    }
  },
}));
