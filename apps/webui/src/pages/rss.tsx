/**
 * RSS 订阅管理 — React/AntD port of pages/index/rss.vue。
 * 列表（名称/链接/状态/上次检查）+ 添加、编辑、刷新、删除、查看种子。
 */
import { useEffect, useState } from 'react';
import { Button, Card, Modal, Space, Table, Tag, Tooltip, Typography, theme } from 'antd';
import type { TableProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';

import { apiRss } from '@/api/rss';
import { useRssStore } from '@/stores/rss';
import { AddRssModal } from '@/components/rss/add-rss-modal';
import { EditRssModal } from '@/components/rss/edit-rss-modal';
import { RssTorrentsDrawer } from '@/components/rss/rss-torrents-drawer';
import type { RSS } from '@ab/types';

export function RssPage() {
  const { token } = theme.useToken();
  const {
    rss,
    selectedIds,
    loading,
    refreshingAll,
    getAll,
    setSelected,
    enableSelected,
    disableSelected,
    deleteSelected,
    deleteOne,
    refreshAll,
  } = useRssStore();

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<RSS | null>(null);
  const [torrentsOf, setTorrentsOf] = useState<RSS | null>(null);

  // 单行刷新状态（对应 Vue 版 refreshingId / refreshFailedId）
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [refreshFailedId, setRefreshFailedId] = useState<number | null>(null);

  useEffect(() => {
    void getAll();
  }, [getAll]);

  async function onRefreshOne(id: number) {
    setRefreshingId(id);
    try {
      await apiRss.refresh(id);
      setRefreshFailedId(null);
      void getAll();
    } catch {
      setRefreshFailedId(id);
    } finally {
      setRefreshingId(null);
    }
  }

  function onDeleteSelected() {
    Modal.confirm({
      title: '删除',
      content: '确定删除所选 RSS 订阅？已有规则和下载不受影响。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => deleteSelected(),
    });
  }

  function onDeleteOne(row: RSS) {
    Modal.confirm({
      title: '删除',
      content: `确定删除 RSS 订阅「${row.name || row.url}」？已有规则和下载不受影响。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => deleteOne(row.id),
    });
  }

  const columns: ColumnsType<RSS> = [
    {
      // 名称列同时承载来源元信息（解析器 / 聚合），状态列只保留运行状态
      title: '名称',
      key: 'name',
      render: (_, row) => (
        <Space size={6} wrap>
          <Typography.Text strong ellipsis style={{ maxWidth: 260 }} title={row.name ?? ''}>
            {row.name || '（未命名）'}
          </Typography.Text>
          {row.parser && <Tag>{row.parser}</Tag>}
          {row.aggregate && <Tag color="blue">聚合</Tag>}
        </Space>
      ),
    },
    {
      title: '链接',
      dataIndex: 'url',
      key: 'url',
      ellipsis: true,
      render: (url: string) => (
        <Tooltip title={url}>
          <Typography.Text type="secondary">{url}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 190,
      render: (_, row) => (
        <Space size={4} wrap>
          {row.connection_status === 'healthy' && <Tag color="success">已连接</Tag>}
          {row.connection_status === 'error' && (
            <Tooltip title={row.last_error || 'Unknown error'}>
              <Tag color="error">错误</Tag>
            </Tooltip>
          )}
          {row.enabled ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>}
        </Space>
      ),
    },
    {
      title: '上次检查',
      dataIndex: 'last_checked_at',
      key: 'last_checked_at',
      width: 150,
      render: (v: string | null) => (v ? dayjs(v).format('MM-DD HH:mm:ss') : '—'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_, row) => (
        <Space size={0}>
          <Tooltip title="刷新">
            <Button
              size="small"
              type="text"
              danger={refreshFailedId === row.id}
              loading={refreshingId === row.id}
              icon={<ReloadOutlined />}
              onClick={() => void onRefreshOne(row.id)}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => setEditing(row)}
            />
          </Tooltip>
          <Tooltip title="查看种子">
            <Button
              size="small"
              type="text"
              icon={<UnorderedListOutlined />}
              onClick={() => setTorrentsOf(row)}
            />
          </Tooltip>
          <Tooltip title="删除">
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => onDeleteOne(row)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  const rowSelection: TableProps<RSS>['rowSelection'] = {
    selectedRowKeys: selectedIds,
    onChange: (keys) => setSelected(keys.map(Number)),
  };

  return (
    <Card
      title="RSS 条目"
      extra={
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            添加 RSS
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={refreshingAll}
            onClick={() => void refreshAll()}
          >
            全部刷新
          </Button>
        </Space>
      }
    >
      <Table<RSS>
        columns={columns}
        dataSource={rss}
        rowKey="id"
        rowSelection={rowSelection}
        loading={loading && rss.length === 0}
        pagination={false}
        scroll={{ x: 900 }}
      />

      {selectedIds.length > 0 && (
        <>
          <div
            style={{
              height: 1,
              background: token.colorBorderSecondary,
              margin: '12px 0',
            }}
          />
          <div
            style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}
          >
            <Button type="primary" onClick={() => void enableSelected()}>
              启用
            </Button>
            <Button onClick={() => void disableSelected()}>禁用</Button>
            <Button danger onClick={onDeleteSelected}>
              删除
            </Button>
          </div>
        </>
      )}

      <AddRssModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => void getAll()}
      />
      <EditRssModal rss={editing} onClose={() => setEditing(null)} />
      <RssTorrentsDrawer rss={torrentsOf} onClose={() => setTorrentsOf(null)} />
    </Card>
  );
}
