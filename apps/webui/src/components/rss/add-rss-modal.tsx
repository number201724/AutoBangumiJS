/**
 * 添加 RSS 对话框 — React/AntD port of components/ab-add-rss.vue。
 * 两步流程：输入 URL →（非聚合）解析预览 → 订阅 / 收集整季。
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { LinkOutlined, PictureOutlined } from '@ant-design/icons';

import { apiRss } from '@/api/rss';
import { resolvePosterUrl } from '@/utils/poster';
import { msgZh } from '@/utils/response';
import type { Bangumi } from '@ab/types';

const PARSER_TYPES = ['tmdb', 'mikan', 'parser', 'ani'];

interface Props {
  open: boolean;
  onClose: () => void;
  /** 添加 / 订阅 / 收集成功后调用（刷新 RSS 列表）。 */
  onAdded: () => void;
}

export function AddRssModal({ open, onClose, onAdded }: Props) {
  const [step, setStep] = useState<'input' | 'confirm'>('input');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [aggregate, setAggregate] = useState(false);
  const [parser, setParser] = useState<string>('tmdb');
  const [preview, setPreview] = useState<Partial<Bangumi> | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [subscribing, setSubscribing] = useState(false);

  // 关闭时重置状态（对应 Vue 版 watch(show)）
  useEffect(() => {
    if (!open) {
      setStep('input');
      setUrl('');
      setName('');
      setAggregate(false);
      setParser('tmdb');
      setPreview(null);
    }
  }, [open]);

  async function onAnalyze() {
    if (!url.trim()) {
      void message.error('请输入RSS链接!');
      return;
    }
    setAnalyzing(true);
    try {
      if (aggregate) {
        // 聚合 RSS 无需解析单条番剧，直接入库
        const res = await apiRss.add({
          url: url.trim(),
          name: name.trim() || null,
          aggregate: true,
          parser,
        });
        void message.success(msgZh(res, '添加成功'));
        onAdded();
        onClose();
      } else {
        const res = await apiRss.analysis(url.trim(), parser);
        setPreview(res as unknown as Partial<Bangumi>);
        setStep('confirm');
      }
    } catch {
      /* 错误提示由 axios 拦截器统一弹出 */
    } finally {
      setAnalyzing(false);
    }
  }

  async function onCollect() {
    if (!preview) return;
    setCollecting(true);
    try {
      const res = await apiRss.collect(preview);
      void message.success(msgZh(res, '收集成功'));
      onAdded();
      onClose();
    } catch {
      /* interceptor toasts */
    } finally {
      setCollecting(false);
    }
  }

  async function onSubscribe() {
    if (!preview) return;
    setSubscribing(true);
    try {
      const res = await apiRss.subscribe(preview, parser);
      void message.success(msgZh(res, '订阅成功'));
      onAdded();
      onClose();
    } catch {
      /* interceptor toasts */
    } finally {
      setSubscribing(false);
    }
  }

  function patchPreview(patch: Partial<Bangumi>) {
    setPreview((p) => (p ? { ...p, ...patch } : p));
  }

  const footer =
    step === 'input'
      ? [
          <Button key="ok" type="primary" loading={analyzing} onClick={() => void onAnalyze()}>
            {aggregate ? '添加' : '解析'}
          </Button>,
        ]
      : [
          <Button key="prev" style={{ float: 'left' }} onClick={() => setStep('input')}>
            上一步
          </Button>,
          <Button key="collect" loading={collecting} onClick={() => void onCollect()}>
            收集
          </Button>,
          <Button
            key="subscribe"
            type="primary"
            loading={subscribing}
            onClick={() => void onSubscribe()}
          >
            订阅
          </Button>,
        ];

  return (
    <Modal open={open} title="添加 RSS" onCancel={onClose} width={560} footer={footer} destroyOnClose>
      {step === 'input' ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Typography.Text strong>RSS 链接</Typography.Text>
            <Input
              style={{ marginTop: 8 }}
              prefix={<LinkOutlined style={{ color: '#999' }} />}
              placeholder="请输入 RSS 链接"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPressEnter={() => void onAnalyze()}
            />
          </div>
          <div>
            <Typography.Text strong>名称</Typography.Text>
            <Input
              style={{ marginTop: 8 }}
              placeholder="可选"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Space
            size={24}
            wrap
            style={{
              width: '100%',
              justifyContent: 'space-between',
              padding: 16,
              background: 'rgba(0, 0, 0, 0.03)',
              borderRadius: 8,
            }}
          >
            <Space size={12}>
              <Typography.Text>聚合 RSS</Typography.Text>
              <Switch checked={aggregate} onChange={setAggregate} />
            </Space>
            <Space size={12}>
              <Typography.Text>解析器</Typography.Text>
              <Select
                value={parser}
                options={PARSER_TYPES.map((p) => ({ value: p, label: p }))}
                onChange={setParser}
                style={{ width: 140 }}
              />
            </Space>
          </Space>
        </Space>
      ) : (
        preview && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <div
                style={{
                  width: 80,
                  height: 112,
                  flexShrink: 0,
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: 'rgba(0, 0, 0, 0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {preview.poster_link ? (
                  <img
                    src={resolvePosterUrl(preview.poster_link)}
                    alt={preview.official_title ?? ''}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <PictureOutlined style={{ fontSize: 28, color: '#999' }} />
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Input
                  value={preview.official_title ?? ''}
                  placeholder="官方名称"
                  onChange={(e) => patchPreview({ official_title: e.target.value })}
                  style={{ fontWeight: 600, marginBottom: 8 }}
                />
                {preview.title_raw && (
                  <Typography.Paragraph
                    type="secondary"
                    ellipsis
                    style={{ marginBottom: 8, fontSize: 13 }}
                  >
                    {preview.title_raw}
                  </Typography.Paragraph>
                )}
                <Space size={8} wrap align="center">
                  <Space size={4} align="center">
                    <Typography.Text type="secondary">S</Typography.Text>
                    <InputNumber
                      min={1}
                      value={preview.season ?? 1}
                      onChange={(v) => patchPreview({ season: v ?? 1 })}
                      style={{ width: 64 }}
                    />
                  </Space>
                  {preview.group_name && <Tag color="blue">{preview.group_name}</Tag>}
                  {preview.year && (
                    <Typography.Text type="secondary">{preview.year}</Typography.Text>
                  )}
                </Space>
              </div>
            </div>
            {preview.rss_link && (
              <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                RSS：{preview.rss_link}
              </Typography.Text>
            )}
          </Space>
        )
      )}
    </Modal>
  );
}
