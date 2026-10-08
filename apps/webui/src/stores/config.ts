/**
 * Config store — React port of the Vue webui's store/config.ts:
 * 服务端快照 + 工作副本 + 按段脏值跟踪。设置页各分区直接编辑工作副本，
 * 底部操作栏统一提交；成功后重置快照。
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { Config, UpdateConfig } from '@ab/types';

import { apiConfig } from '@/api/config';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 逐段比较配置，返回有未保存改动的段名（与 Vue 版 dirtyConfigGroups 一致）。 */
export function dirtyConfigGroups(
  saved: Config | null,
  draft: Config | null,
): Array<keyof Config> {
  if (!saved || !draft) return [];
  return (Object.keys(saved) as Array<keyof Config>).filter(
    (key) => JSON.stringify(saved[key]) !== JSON.stringify(draft[key]),
  );
}

interface ConfigState {
  /** 最近一次从服务端加载/成功保存的快照（脏值比对基准） */
  saved: Config | null;
  /** 工作副本（设置页各分区直接编辑） */
  draft: Config | null;
  loading: boolean;
  load: () => Promise<void>;
  setGroup: <K extends keyof Config>(key: K, value: Config[K]) => void;
  /** 放弃修改：重新从服务端拉取（Vue 版语义） */
  discard: () => Promise<void>;
  /** 提交整个工作副本；成功后重置快照 */
  save: () => Promise<void>;
  /**
   * 软件更新分区的 channel/auto_check：有未保存修改时只改内存（随全局保存提交），
   * 否则即时写回后端（Vue 版 update-card 语义）。
   */
  persistUpdateConfig: (patch: Partial<UpdateConfig>) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  saved: null,
  draft: null,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const config = await apiConfig.get();
      set({ saved: clone(config), draft: config });
    } finally {
      set({ loading: false });
    }
  },

  setGroup: (key, value) => {
    const { draft } = get();
    if (!draft) return;
    set({ draft: { ...draft, [key]: value } });
  },

  discard: async () => {
    await get().load();
  },

  save: async () => {
    const { draft } = get();
    if (!draft) return;
    await apiConfig.update(draft);
    set({ saved: clone(draft) });
  },

  persistUpdateConfig: async (patch) => {
    const isDirty = dirtyConfigGroups(get().saved, get().draft).length > 0;
    if (isDirty) {
      const { draft, setGroup } = get();
      if (draft) setGroup('update', { ...draft.update, ...patch });
      return;
    }
    // 无未保存修改：先同步服务端，再合并提交，最后重新拉取（拿回掩码后的敏感字段）
    await get().load();
    const { draft } = get();
    if (!draft) return;
    get().setGroup('update', { ...draft.update, ...patch });
    await get().save();
    await get().load();
  },
}));

/**
 * 读取一个配置段及 setter。设置页保证 draft 加载完成后才渲染分区，
 * 因此此处直接抛错而不是返回空值。
 */
export function useConfigGroup<K extends keyof Config>(
  key: K,
): [Config[K], (value: Config[K]) => void] {
  const group = useConfigStore((s) => s.draft?.[key]);
  const setGroup = useConfigStore((s) => s.setGroup);
  if (group === undefined) {
    throw new Error('Config not loaded');
  }
  return [group, (value) => setGroup(key, value)];
}

/** 当前有未保存修改的配置段列表。 */
export function useDirtyGroups(): Array<keyof Config> {
  const saved = useConfigStore((s) => s.saved);
  const draft = useConfigStore((s) => s.draft);
  return useMemo(() => dirtyConfigGroups(saved, draft), [saved, draft]);
}
