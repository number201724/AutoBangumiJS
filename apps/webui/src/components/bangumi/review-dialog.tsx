/**
 * 需要检查（needs-review）列表对话框 — 对应任务书：
 * 页面顶部 Alert 提示 N 部番剧需要检查 → 本对话框列出官方标题、原因、
 * 建议的 season_offset/episode_offset，支持单个应用 / 全部应用 / 忽略。
 */
import { useState } from 'react';
import { Button, List, Modal, Tag, Typography, message } from 'antd';
import type { Bangumi } from '@ab/types';

import { apiBangumi } from '@/api/bangumi';
import { msgOf } from './utils';

interface ReviewDialogProps {
  open: boolean;
  items: Bangumi[];
  onClose: () => void;
  /** 任何应用/忽略成功后回调，让父组件刷新 needsReview 列表与番剧列表 */
  onChanged: () => void;
}

export function ReviewDialog({ open, items, onClose, onChanged }: ReviewDialogProps) {
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [applyAllLoading, setApplyAllLoading] = useState(false);

  function setBusy(id: number, v: boolean) {
    setBusyIds((s) => {
      const next = new Set(s);
      if (v) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function applyOne(b: Bangumi) {
    setBusy(b.id, true);
    try {
      const res = await apiBangumi.applyOffset(b.id);
      void message.success(msgOf(res, '已应用偏移量。'));
      onChanged();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setBusy(b.id, false);
    }
  }

  async function dismissOne(b: Bangumi) {
    setBusy(b.id, true);
    try {
      const res = await apiBangumi.dismissReview(b.id);
      void message.success(msgOf(res, '检查提醒已忽略'));
      onChanged();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setBusy(b.id, false);
    }
  }

  async function applyAll() {
    setApplyAllLoading(true);
    try {
      const res = await apiBangumi.applyOffsetMany(items.map((b) => b.id));
      void message.success(msgOf(res, '已应用全部偏移量。'));
      onChanged();
      onClose();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setApplyAllLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      title={`需要检查偏移量（${items.length}）`}
      width={560}
      onCancel={onClose}
      footer={
        <>
          <Button size="small" onClick={onClose}>
            关闭
          </Button>
          <Button
            size="small"
            type="primary"
            loading={applyAllLoading}
            disabled={items.length === 0}
            onClick={() => void applyAll()}
          >
            全部应用
          </Button>
        </>
      }
    >
      <List
        dataSource={items}
        locale={{ emptyText: '暂无需要检查的番剧' }}
        renderItem={(b) => {
          const hasSuggestion =
            b.suggested_season_offset != null || b.suggested_episode_offset != null;
          return (
            <List.Item
              actions={[
                <Button
                  key="apply"
                  size="small"
                  type="primary"
                  disabled={!hasSuggestion}
                  loading={busyIds.has(b.id)}
                  onClick={() => void applyOne(b)}
                >
                  应用
                </Button>,
                <Button
                  key="dismiss"
                  size="small"
                  loading={busyIds.has(b.id)}
                  onClick={() => void dismissOne(b)}
                >
                  忽略
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <span>
                    {b.official_title}
                    <Tag style={{ marginLeft: 8 }}>{`S${b.season}`}</Tag>
                  </span>
                }
                description={
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {b.needs_review_reason && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {b.needs_review_reason}
                      </Typography.Text>
                    )}
                    {hasSuggestion && (
                      <Typography.Text style={{ fontSize: 12 }}>
                        建议：季度偏移 {b.suggested_season_offset ?? 0}，集数偏移{' '}
                        {b.suggested_episode_offset ?? 0}
                      </Typography.Text>
                    )}
                  </div>
                }
              />
            </List.Item>
          );
        }}
      />
    </Modal>
  );
}
