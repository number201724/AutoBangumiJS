/** RSS 种子列表抽屉 — 查看某个 RSS 源抓取到的种子记录。 */
import { useEffect, useState } from 'react';
import { Drawer, List, Tag, Tooltip, Typography } from 'antd';
import { LinkOutlined } from '@ant-design/icons';

import { apiRss } from '@/api/rss';
import type { RSS, Torrent } from '@ab/types';

interface Props {
  /** 目标 RSS；null 表示关闭。 */
  rss: RSS | null;
  onClose: () => void;
}

export function RssTorrentsDrawer({ rss, onClose }: Props) {
  const [torrents, setTorrents] = useState<Torrent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!rss) {
      setTorrents([]);
      return;
    }
    setLoading(true);
    apiRss
      .getTorrents(rss.id)
      .then(setTorrents)
      .catch(() => setTorrents([]))
      .finally(() => setLoading(false));
  }, [rss]);

  return (
    <Drawer
      open={rss !== null}
      onClose={onClose}
      width={560}
      title={rss ? `种子列表 — ${rss.name || rss.url}` : '种子列表'}
    >
      <List<Torrent>
        loading={loading}
        dataSource={torrents}
        locale={{ emptyText: '暂无种子' }}
        renderItem={(t) => (
          <List.Item
            actions={[
              t.downloaded ? (
                <Tag key="dl" color="success">
                  已下载
                </Tag>
              ) : (
                <Tag key="dl">未下载</Tag>
              ),
              ...(t.homepage
                ? [
                    <Tooltip key="hp" title="打开来源页">
                      <a href={t.homepage} target="_blank" rel="noreferrer">
                        <LinkOutlined />
                      </a>
                    </Tooltip>,
                  ]
                : []),
            ]}
          >
            <List.Item.Meta
              title={
                <Tooltip title={t.name}>
                  <Typography.Text style={{ wordBreak: 'break-all' }}>{t.name}</Typography.Text>
                </Tooltip>
              }
              description={
                <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                  {t.url}
                </Typography.Text>
              }
            />
          </List.Item>
        )}
      />
    </Drawer>
  );
}
