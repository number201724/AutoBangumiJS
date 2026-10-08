/**
 * 孤儿（未匹配）种子页 — 移植自 Vue 版 pages/index/bangumi-torrents/orphans/index.vue。
 * 列出未匹配到任何番剧规则的种子，支持逐条删除与全部清理。
 */
import { apiBangumi } from '@/api/bangumi';
import { TorrentListPage } from '@/components/bangumi/torrent-list-page';

export function OrphansPage() {
  return (
    <TorrentListPage
      title="未匹配种子"
      loadFn={() => apiBangumi.getOrphans()}
      deleteOne={(torrentId) => apiBangumi.deleteOrphan(torrentId)}
      deleteAll={() => apiBangumi.deleteOrphans()}
    />
  );
}
