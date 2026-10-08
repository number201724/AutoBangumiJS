/**
 * SSE 聚合流 store — mirrors the Vue webui's useEventStream data sinks.
 * One /api/v1/events/stream connection feeding status/downloader/log/notification.
 */
import { create } from 'zustand';

import type { TorrentInfo } from '@/api/downloader';

export interface ProgramStatusPayload {
  status: boolean;
  version: string;
  first_run: boolean;
}

export interface NotificationPayload {
  unread_count: number;
  latest_id: number;
  revision: number;
}

interface EventsState {
  status: ProgramStatusPayload | null;
  /** null = 下载器不可用（前端保留旧数据由页面处理；这里原样存储） */
  torrents: TorrentInfo[] | null;
  log: string | null;
  notification: NotificationPayload | null;
  update: Record<string, unknown> | null;
  connected: boolean;
  setStatus: (v: ProgramStatusPayload) => void;
  setTorrents: (v: TorrentInfo[] | null) => void;
  setLog: (v: string) => void;
  setNotification: (v: NotificationPayload) => void;
  setUpdate: (v: Record<string, unknown> | null) => void;
  setConnected: (v: boolean) => void;
}

export const useEventsStore = create<EventsState>((set) => ({
  status: null,
  torrents: null,
  log: null,
  notification: null,
  update: null,
  connected: false,
  setStatus: (status) => set({ status }),
  setTorrents: (torrents) => set({ torrents }),
  setLog: (log) => set({ log }),
  setNotification: (notification) => set({ notification }),
  setUpdate: (update) => set({ update }),
  setConnected: (connected) => set({ connected }),
}));
