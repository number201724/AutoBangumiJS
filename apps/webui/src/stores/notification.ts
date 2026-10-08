/**
 * Notification center store — React port of store/notification.ts.
 * SSE-driven unread count + message list with localized kind rendering.
 */
import { create } from 'zustand';
import { message as antdMessage } from 'antd';

import { apiNotification } from '@/api/notification';
import { useEventsStore } from '@/stores/events';
import type { InboxMessage } from '@ab/types';

const KNOWN_KINDS = [
  'rss_failure',
  'download_failure',
  'offset_review',
  'downloader_unavailable',
  'update_available',
  'update_applied',
  'update_failed',
  'llm_auth_failure',
  'llm_plugin_install_failed',
  'rename_conflict',
] as const;

const KIND_TITLE: Record<string, string> = {
  rss_failure: 'RSS 订阅连接异常',
  download_failure: '种子添加失败',
  offset_review: '集数偏移待确认',
  downloader_unavailable: '下载器连接异常',
  update_available: '发现新版本',
  update_applied: '程序更新完成',
  update_failed: '程序更新失败',
  llm_auth_failure: 'LLM 提供商凭据失效',
  llm_plugin_install_failed: 'LLM 插件安装失败',
  rename_conflict: '媒体文件重命名冲突',
};

const KIND_BODY: Record<string, string> = {
  rss_failure: '{rss_name}：{error}',
  download_failure: '{official_title} — {torrent_name}',
  offset_review: '{official_title}：{reason}',
  update_available: '{current} → {latest}（{channel} 频道）',
  update_applied: '已更新到 {version}，重启后生效。',
  update_failed: '{message}',
  llm_auth_failure: '{provider_id}：{message}',
  llm_plugin_install_failed: '{plugin_id}：{message}',
  rename_conflict: '{torrent_name} → {target_path}：{reason}',
};

const REASON_TEXT: Record<string, string> = {
  unreachable: '无法连接',
  credentials: '凭据错误',
  banned: 'IP 被封禁',
};

function render(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(payload[k] ?? ''));
}

export function titleOf(msg: InboxMessage): string {
  if (!KNOWN_KINDS.includes(msg.kind as (typeof KNOWN_KINDS)[number])) {
    return msg.title;
  }
  return KIND_TITLE[msg.kind] ?? msg.title;
}

export function bodyOf(msg: InboxMessage): string {
  if (!KNOWN_KINDS.includes(msg.kind as (typeof KNOWN_KINDS)[number])) {
    return msg.body;
  }
  const payload = (msg.payload ?? {}) as Record<string, unknown>;
  if (msg.kind === 'downloader_unavailable') {
    const reason = String(payload.reason || 'unreachable');
    return `${payload.host ?? ''}: ${REASON_TEXT[reason] ?? reason}`;
  }
  return render(KIND_BODY[msg.kind] ?? msg.body, payload);
}

interface NotificationState {
  messages: InboxMessage[];
  total: number;
  unreadCount: number;
  isLoading: boolean;
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  setUnreadCount: (n: number) => void;
  fetchMessages: () => Promise<void>;
  fetchUnread: () => Promise<void>;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  remove: (id: number) => Promise<void>;
  clearAll: () => Promise<void>;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  messages: [],
  total: 0,
  unreadCount: 0,
  isLoading: false,
  panelOpen: false,
  setPanelOpen: (v) => set({ panelOpen: v }),
  setUnreadCount: (n) => set({ unreadCount: n }),
  fetchMessages: async () => {
    set({ isLoading: true });
    try {
      const res = await apiNotification.listMessages(false, 50, 0);
      set({ messages: res.messages as InboxMessage[], total: res.total, unreadCount: res.unread_count });
    } catch {
      // 后台刷新失败保留旧数据
    } finally {
      set({ isLoading: false });
    }
  },
  fetchUnread: async () => {
    try {
      const res = await apiNotification.unreadCount();
      set({ unreadCount: res.unread_count });
    } catch {
      // silent
    }
  },
  markRead: async (id) => {
    try {
      await apiNotification.markRead(id);
      set((s) => ({
        messages: s.messages.map((m) => (m.id === id ? { ...m, read: true } : m)),
        unreadCount: Math.max(0, s.unreadCount - 1),
      }));
    } catch {
      /* interceptor toasts */
    }
  },
  markAllRead: async () => {
    try {
      await apiNotification.markAllRead();
      set((s) => ({
        messages: s.messages.map((m) => ({ ...m, read: true })),
        unreadCount: 0,
      }));
    } catch {
      /* interceptor toasts */
    }
  },
  remove: async (id) => {
    try {
      const wasUnread = get().messages.find((m) => m.id === id)?.read === false;
      await apiNotification.deleteMessage(id);
      set((s) => ({
        messages: s.messages.filter((m) => m.id !== id),
        total: Math.max(0, s.total - 1),
        unreadCount: wasUnread ? Math.max(0, s.unreadCount - 1) : s.unreadCount,
      }));
    } catch {
      /* interceptor toasts */
    }
  },
  clearAll: async () => {
    try {
      await apiNotification.clearMessages();
      set({ messages: [], total: 0, unreadCount: 0 });
    } catch {
      /* interceptor toasts */
    }
  },
}));

// SSE 帧同步：latest_id 增大 = 有新消息 → 刷新列表并对 error 级新消息弹
// toast（跳过第一帧，避免为历史积压刷屏）；面板打开时其它端操作也同步。
let lastLatestId: number | null = null;
useEventsStore.subscribe((state, prev) => {
  const frame = state.notification;
  if (!frame || frame === prev.notification) return;
  const s = useNotificationStore.getState();
  s.setUnreadCount(frame.unread_count);
  const isFirstFrame = lastLatestId === null;
  const hasNew = !isFirstFrame && frame.latest_id > (lastLatestId as number);
  lastLatestId = frame.latest_id;
  if (hasNew) {
    void s.fetchMessages().then(() => {
      const head = useNotificationStore.getState().messages[0];
      if (head && !head.read && head.severity === 'error') {
        void antdMessage.error(titleOf(head));
      }
    });
  } else if (s.panelOpen && !isFirstFrame) {
    void s.fetchMessages();
  }
});
