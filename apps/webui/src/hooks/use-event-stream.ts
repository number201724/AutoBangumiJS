/**
 * useEventStream — React port of hooks/useEventStream.ts.
 *
 * Subscribes to /api/v1/events/stream (status/downloader/log/notification/
 * update). On failure it falls back to plain polling of the same data
 * sources, mirroring the Vue hook's degrade path.
 */
import { useEffect } from 'react';

import { api } from '@/api/client';
import { useEventsStore } from '@/stores/events';
import { useAuthStore } from '@/stores/auth';

const POLL_INTERVAL_MS = 10_000;

async function pollOnce(): Promise<void> {
  const s = useEventsStore.getState();
  try {
    const [status, torrents, unread, log] = await Promise.all([
      api.get('api/v1/status', { silent: true }).then((r) => r.data).catch(() => null),
      api.get('api/v1/downloader/torrents', { silent: true }).then((r) => r.data).catch(() => null),
      api
        .get('api/v1/notification/messages/unread-count', { silent: true })
        .then((r) => r.data)
        .catch(() => null),
      api.get('api/v1/log', { silent: true }).then((r) => r.data).catch(() => null),
    ]);
    if (status) s.setStatus(status);
    if (torrents !== null) s.setTorrents(torrents);
    if (unread) s.setNotification({ ...unread, latest_id: 0, revision: 0 });
    if (log !== null) s.setLog(log);
  } catch {
    /* next tick retries */
  }
}

export function useEventStream(): void {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);

  useEffect(() => {
    if (!isLoggedIn) return;

    let stopped = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const startPolling = () => {
      if (pollTimer) return;
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const connect = () => {
      if (stopped) return;
      es = new EventSource('api/v1/events/stream');
      const s = useEventsStore.getState;

      es.addEventListener('open', () => {
        stopPolling();
        s().setConnected(true);
      });
      es.addEventListener('status', (e) => {
        try {
          s().setStatus(JSON.parse((e as MessageEvent).data));
        } catch {
          /* keep last */
        }
      });
      es.addEventListener('downloader', (e) => {
        try {
          s().setTorrents(JSON.parse((e as MessageEvent).data));
        } catch {
          /* keep last */
        }
      });
      es.addEventListener('log', (e) => {
        s().setLog((e as MessageEvent).data);
      });
      es.addEventListener('notification', (e) => {
        try {
          s().setNotification(JSON.parse((e as MessageEvent).data));
        } catch {
          /* keep last */
        }
      });
      es.addEventListener('update', (e) => {
        try {
          s().setUpdate(JSON.parse((e as MessageEvent).data));
        } catch {
          /* keep last */
        }
      });
      es.addEventListener('error', () => {
        s().setConnected(false);
        es?.close();
        es = null;
        if (stopped) return;
        // 事件流失败：回退轮询，30s 后尝试重连 SSE
        startPolling();
        retryTimer = setTimeout(() => {
          stopPolling();
          connect();
        }, 30_000);
      });
    };

    connect();

    return () => {
      stopped = true;
      es?.close();
      stopPolling();
      if (retryTimer) clearTimeout(retryTimer);
      useEventsStore.getState().setConnected(false);
    };
  }, [isLoggedIn]);
}
