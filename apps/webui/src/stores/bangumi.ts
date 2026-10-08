/**
 * Bangumi store — 镜像 Vue webui 的 pinia store/bangumi.ts 数据流语义：
 * getAll 排序（未删除按 id 倒序在前，已删除在后）、变更后刷新列表、
 * 错误提示交给 axios 拦截器，成功提示在此弹出。
 */
import { create } from 'zustand';
import { message } from 'antd';
import type { Bangumi } from '@ab/types';

import { apiBangumi } from '@/api/bangumi';
import { msgOf } from '@/components/bangumi/utils';

interface BangumiState {
  bangumi: Bangumi[];
  showArchived: boolean;
  isLoading: boolean;
  hasLoaded: boolean;
  loadFailed: boolean;

  getAll: () => Promise<void>;
  setShowArchived: (v: boolean) => void;

  /** 以下变更动作：成功 toast + 刷新列表并返回 true；失败返回 false（拦截器已提示） */
  updateRule: (id: number, payload: Partial<Bangumi>) => Promise<boolean>;
  enableRule: (id: number) => Promise<boolean>;
  disableRule: (id: number, file: boolean) => Promise<boolean>;
  deleteRule: (id: number, file: boolean) => Promise<boolean>;
  refreshPoster: (id: number) => Promise<boolean>;
  archiveRule: (id: number) => Promise<boolean>;
  unarchiveRule: (id: number) => Promise<boolean>;
  /** 设置放送日；成功后只改本地条目（与 Vue 版一致，不整表刷新） */
  setWeekday: (id: number, weekday: number | null) => Promise<boolean>;
}

export const useBangumiStore = create<BangumiState>((set, get) => {
  /** 变更动作模板：toast 后端 msg_zh，成功后刷新列表 */
  async function runAndRefresh(
    fn: () => Promise<unknown>,
    fallback: string,
  ): Promise<boolean> {
    try {
      const res = await fn();
      void message.success(msgOf(res, fallback));
      await get().getAll();
      return true;
    } catch {
      return false;
    }
  }

  return {
    bangumi: [],
    showArchived: false,
    isLoading: false,
    hasLoaded: false,
    loadFailed: false,

    async getAll() {
      set({ isLoading: true });
      try {
        const res = await apiBangumi.getAll();
        const sort = (arr: Bangumi[]) => arr.sort((a, b) => b.id - a.id);
        const enabled = sort(res.filter((e) => !e.deleted));
        const disabled = sort(res.filter((e) => e.deleted));
        set({ bangumi: [...enabled, ...disabled], hasLoaded: true, loadFailed: false });
      } catch {
        // 保留已加载数据；首次加载失败与“空库”通过 loadFailed/hasLoaded 区分
        set({ loadFailed: true });
      } finally {
        set({ isLoading: false });
      }
    },

    setShowArchived: (v) => set({ showArchived: v }),

    updateRule: (id, payload) =>
      runAndRefresh(() => apiBangumi.update(id, payload), '规则已更新。'),
    enableRule: (id) => runAndRefresh(() => apiBangumi.enable(id), '规则已启用。'),
    disableRule: (id, file) =>
      runAndRefresh(() => apiBangumi.disable(id, file), '规则已禁用。'),
    deleteRule: (id, file) =>
      runAndRefresh(() => apiBangumi.delete(id, file), '规则已删除。'),
    refreshPoster: (id) =>
      runAndRefresh(() => apiBangumi.refreshPoster(id), '海报已刷新。'),
    archiveRule: (id) => runAndRefresh(() => apiBangumi.archive(id), '规则已归档。'),
    unarchiveRule: (id) =>
      runAndRefresh(() => apiBangumi.unarchive(id), '规则已取消归档。'),

    async setWeekday(id, weekday) {
      try {
        await apiBangumi.setWeekday(id, weekday);
        set((s) => ({
          bangumi: s.bangumi.map((b) =>
            b.id === id
              ? { ...b, air_weekday: weekday, weekday_locked: weekday !== null }
              : b,
          ),
        }));
        return true;
      } catch {
        return false;
      }
    },
  };
});

/** 选择器辅助：未删除且未归档 */
export function selectActive(list: Bangumi[]): Bangumi[] {
  return list.filter((b) => !b.deleted && !b.archived);
}

/** 选择器辅助：未删除且已归档 */
export function selectArchived(list: Bangumi[]): Bangumi[] {
  return list.filter((b) => !b.deleted && b.archived);
}
