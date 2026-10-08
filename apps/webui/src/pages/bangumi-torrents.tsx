/**
 * 单番种子记录页 — 移植自 Vue 版 pages/index/bangumi-torrents/[id]/index.vue。
 * 路由 /bangumi-torrents/:id；非法 id 直接回番剧列表。
 */
import { useMemo } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import { apiBangumi } from '@/api/bangumi';
import { TorrentListPage } from '@/components/bangumi/torrent-list-page';

export function BangumiTorrentsPage() {
  const params = useParams<{ id: string }>();

  // 非法 id 归一为 null（对应 Vue 版 computed bangumiId）
  const bangumiId = useMemo(() => {
    const id = Number(params.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  }, [params.id]);

  if (bangumiId === null) {
    return <Navigate to="/bangumi" replace />;
  }

  return (
    <TorrentListPage
      key={bangumiId}
      title={`种子列表 #${bangumiId}`}
      loadFn={() => apiBangumi.getTorrents(bangumiId)}
      deleteOne={(torrentId) => apiBangumi.deleteTorrent(bangumiId, torrentId)}
      deleteAll={() => apiBangumi.deleteTorrents(bangumiId)}
    />
  );
}
