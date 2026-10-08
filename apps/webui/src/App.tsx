import { useEffect, useState, type ReactElement } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { LoginPage } from '@/pages/login';
import { SetupPage } from '@/pages/setup';
import { MainLayout } from '@/layouts/main-layout';
import { BangumiPage } from '@/pages/bangumi';
import { CalendarPage } from '@/pages/calendar';
import { RssPage } from '@/pages/rss';
import { DownloaderPage } from '@/pages/downloader';
import { LogPage } from '@/pages/log';
import { ConfigPage } from '@/pages/config';
import { PlayerPage } from '@/pages/player';
import { BangumiTorrentsPage } from '@/pages/bangumi-torrents';
import { OrphansPage } from '@/pages/orphans';

function Protected({ children }: { children: ReactElement }) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  if (!isLoggedIn) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [needSetup, setNeedSetup] = useState(false);
  const refresh = useAuthStore((s) => s.refresh);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api.get<{ need_setup: boolean }>('api/v1/setup/status', {
          silent: true,
        });
        setNeedSetup(data.need_setup);
        if (!data.need_setup) {
          await refresh();
        }
      } catch {
        /* backend unreachable — login page will show network errors */
      } finally {
        setBooting(false);
      }
    })();
  }, [refresh]);

  if (booting) return null;

  return (
    <HashRouter>
      <Routes>
        <Route
          path="/login"
          element={needSetup ? <Navigate to="/setup" replace /> : <LoginPage />}
        />
        <Route path="/setup" element={<SetupPage />} />
        <Route
          path="/"
          element={
            <Protected>
              <MainLayout />
            </Protected>
          }
        >
          <Route index element={<Navigate to="/bangumi" replace />} />
          <Route path="bangumi" element={<BangumiPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="rss" element={<RssPage />} />
          <Route path="player" element={<PlayerPage />} />
          <Route path="downloader" element={<DownloaderPage />} />
          <Route path="log" element={<LogPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="bangumi-torrents/orphans" element={<OrphansPage />} />
          <Route path="bangumi-torrents/:id" element={<BangumiTorrentsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
