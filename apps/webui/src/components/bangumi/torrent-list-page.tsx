/**
 * 种子记录列表页 — 移植自 Vue 版 ab-torrent-list-page.vue（AntD Table 实现）。
 * 单番种子记录页与孤儿种子页共用：标题、全选/删除选中、逐条删除、清空所有。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { Torrent } from '@ab/types';

interface TorrentListPageProps {
  title: string;
  loadFn: () => Promise<Torrent[]>;
  deleteOne: (torrentId: number) => Promise<unknown>;
  deleteAll: () => Promise<unknown>;
}

export function TorrentListPage({
  title,
  loadFn,
  deleteOne,
  deleteAll,
}: TorrentListPageProps) {
  const [torrents, setTorrents] = useState<Torrent[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await loadFn();
      setTorrents(data);
    } catch {
      // 错误提示由 axios 拦截器统一弹出
      setTorrents([]);
    } finally {
      setSelectedIds([]);
      setLoading(false);
    }
  }, [loadFn]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 删除动作模板：成功 toast + 重新加载（对应 Vue useTorrentList.runDelete） */
  async function runDelete(fn: () => Promise<unknown>, label: string) {
    setDeleting(true);
    try {
      await fn();
      void message.success(label);
    } catch {
      void message.error('删除失败');
    } finally {
      // 部分失败（批量扇出）时也要刷新，避免已删除的行残留
      await load();
      setDeleting(false);
    }
  }

  async function handleDeleteOne(t: Torrent) {
    await runDelete(() => deleteOne(t.id), `已删除种子 ${t.id}`);
  }

  async function handleDeleteSelected() {
    const ids = [...selectedIds];
    await runDelete(
      () => Promise.all(ids.map((id) => deleteOne(id))),
      `已删除 ${ids.length} 条种子`,
    );
  }

  async function handleClearAll() {
    await runDelete(() => deleteAll(), '已清空所有种子');
  }

  const columns: ColumnsType<Torrent> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: { showTitle: true },
      render: (name: string) => (
        <Typography.Text style={{ fontSize: 13 }} ellipsis={{ tooltip: name }}>
          {name}
        </Typography.Text>
      ),
    },
    {
      title: '状态',
      dataIndex: 'downloaded',
      key: 'downloaded',
      width: 110,
      render: (downloaded: boolean, t) => (
        <Space size={4}>
          {downloaded && <Tag color="success">已下载</Tag>}
          {t.rss_id ? (
            <Tag color="blue">RSS</Tag>
          ) : (
            <Tag>手动/订阅</Tag>
          )}
        </Space>
      ),
    },
    {
      title: '链接',
      dataIndex: 'url',
      key: 'url',
      width: 100,
      render: (url: string) =>
        url ? (
          <Typography.Link href={url} target="_blank" rel="noreferrer">
            种子链接
          </Typography.Link>
        ) : null,
    },
    {
      title: '主页',
      dataIndex: 'homepage',
      key: 'homepage',
      width: 90,
      render: (homepage: string | null) =>
        homepage ? (
          <Typography.Link href={homepage} target="_blank" rel="noreferrer">
            详情页
          </Typography.Link>
        ) : null,
    },
    {
      title: 'Hash',
      dataIndex: 'qb_hash',
      key: 'qb_hash',
      width: 160,
      ellipsis: true,
      render: (hash: string | null) =>
        hash ? <Typography.Text code>{hash}</Typography.Text> : null,
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_, t) => (
        <Button
          size="small"
          type="text"
          danger
          icon={<DeleteOutlined />}
          aria-label="删除"
          onClick={() => void handleDeleteOne(t)}
        />
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
          <Typography.Text type="secondary" style={{ fontSize: 13, marginLeft: 8 }}>
            共 {torrents.length} 条
          </Typography.Text>
        </Typography.Title>
        <Space wrap>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
          {selectedIds.length > 0 && (
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              loading={deleting}
              onClick={() => void handleDeleteSelected()}
            >
              {`删除 (${selectedIds.length})`}
            </Button>
          )}
          {torrents.length > 0 && (
            <Popconfirm
              title="清空所有"
              description="确定要清空所有种子吗？此操作不可撤销。"
              okText="清空所有"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void handleClearAll()}
            >
              <Button size="small" danger icon={<DeleteOutlined />} loading={deleting}>
                清空所有
              </Button>
            </Popconfirm>
          )}
        </Space>
      </div>

      <Table<Torrent>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={torrents}
        locale={{ emptyText: '暂无种子' }}
        pagination={false}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys.map(Number)),
        }}
      />
    </div>
  );
}
