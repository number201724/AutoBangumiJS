/** 重命名冲突面板 — 列出持久化的媒体重命名冲突，支持逐个重试。 */
import { useEffect, useState } from 'react';
import { Button, Drawer, List, Typography, message } from 'antd';
import dayjs from 'dayjs';

import { apiDownloader } from '@/api/downloader';
import { msgZh } from '@/utils/response';
import type { RenameOperation } from '@ab/types';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 冲突数量变化时回调（页面右上角角标）。 */
  onCountChange?: (count: number) => void;
}

export function RenameConflictsPanel({ open, onClose, onCountChange }: Props) {
  const [conflicts, setConflicts] = useState<RenameOperation[]>([]);
  const [loading, setLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const list = await apiDownloader.getRenameConflicts();
      setConflicts(list);
      onCountChange?.(list.length);
    } catch {
      /* interceptor toasts */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onRetry(op: RenameOperation) {
    setRetryingId(op.id);
    try {
      const res = await apiDownloader.retryRenameConflict(op.id);
      void message.success(msgZh(res, '重命名冲突已清除，将在下一轮重新校验'));
      await load();
    } catch {
      /* interceptor toasts */
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={560}
      title={`重命名冲突${conflicts.length > 0 ? `（${conflicts.length}）` : ''}`}
    >
      <List<RenameOperation>
        loading={loading}
        dataSource={conflicts}
        locale={{ emptyText: '暂无重命名冲突' }}
        renderItem={(op) => (
          <List.Item
            actions={[
              <Button
                key="retry"
                size="small"
                type="primary"
                loading={retryingId === op.id}
                onClick={() => void onRetry(op)}
              >
                重试
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <Typography.Text style={{ wordBreak: 'break-all' }} copyable={{ text: op.target_path }}>
                  {op.target_path}
                </Typography.Text>
              }
              description={
                <>
                  {op.last_error && (
                    <Typography.Text type="danger" style={{ display: 'block', fontSize: 12 }}>
                      {op.last_error}
                    </Typography.Text>
                  )}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(op.updated_at).format('YYYY-MM-DD HH:mm:ss')} · 已尝试 {op.attempt_count} 次
                  </Typography.Text>
                </>
              }
            />
          </List.Item>
        )}
      />
    </Drawer>
  );
}
