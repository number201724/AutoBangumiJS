/** Log store — mirrors webui/src/store/log.ts (zustand port). */
import { create } from 'zustand';
import { message } from 'antd';

import { apiLog } from '@/api/log';
import { msgZh } from '@/utils/response';

interface LogState {
  log: string;
  /** 仅手动刷新时转动按钮；静默轮询不动 UI。 */
  refreshing: boolean;

  getLog: (manual?: boolean) => Promise<void>;
  clearLog: () => Promise<void>;
}

export const useLogStore = create<LogState>((set, get) => ({
  log: '',
  refreshing: false,

  getLog: async (manual = false) => {
    if (manual) set({ refreshing: true });
    try {
      const log = await apiLog.get();
      set({ log });
    } catch {
      // 静默轮询失败：保留旧内容
    } finally {
      if (manual) set({ refreshing: false });
    }
  },

  clearLog: async () => {
    const res = await apiLog.clear();
    void message.success(msgZh(res, '日志已清空'));
    set({ log: '' });
    await get().getLog();
  },
}));
