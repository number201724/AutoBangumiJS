/**
 * 搜索番剧对话框 — React/AntD port of components/search/ab-search-modal.vue。
 * EventSource 连 api/v1/search/bangumi 逐条渲染结果卡片，可直接订阅。
 */
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { PictureOutlined } from '@ant-design/icons';

import { apiRss } from '@/api/rss';
import { apiSearch } from '@/api/search';
import { resolvePosterUrl } from '@/utils/poster';
import { msgZh } from '@/utils/response';
import type { Bangumi } from '@ab/types';

type StreamStatus = 'idle' | 'connecting' | 'open' | 'done' | 'failed';

interface Props {
  open: boolean;
  onClose: () => void;
}

function resultKey(item: Partial<Bangumi>): string {
  return item.rss_link || item.title_raw || item.official_title || '';
}

export function SearchBangumiModal({ open, onClose }: Props) {
  const [providers, setProviders] = useState<string[]>([]);
  const [site, setSite] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Partial<Bangumi>[]>([]);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [subscribingKey, setSubscribingKey] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  function closeStream() {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }

  // 打开时拉取站点列表；关闭时停流并清空状态
  useEffect(() => {
    if (open) {
      apiSearch
        .getProviders()
        .then((list) => {
          setProviders(list);
          setSite((s) => s || list[0] || '');
        })
        .catch(() => {
          /* 站点列表失败时保留下拉为空，由搜索报错兜底 */
        });
    } else {
      closeStream();
      setResults([]);
      setStatus('idle');
      setKeyword('');
      setSubscribingKey(null);
    }
  }, [open]);

  // 卸载兜底：防止搜索进行中跳页导致流泄漏 / 浏览器无限重连
  useEffect(() => closeStream, []);

  function startSearch() {
    const kw = keyword.trim();
    if (!kw || !site) return;
    // 先关旧流再开新流：否则旧流泄漏且服务端关闭后会无限自动重连
    closeStream();
    setResults([]);
    setStatus('connecting');

    const es = new EventSource(apiSearch.bangumiStreamUrl(site, kw), { withCredentials: true });
    esRef.current = es;

    es.onopen = () => {
      if (esRef.current !== es) return;
      setStatus('open');
    };
    es.onmessage = (e) => {
      // 已被新一次搜索替换的旧流：关掉自己，不再往结果里追加
      if (esRef.current !== es) {
        es.close();
        return;
      }
      try {
        const item = JSON.parse(e.data as string) as Partial<Bangumi>;
        const id = resultKey(item);
        setResults((prev) =>
          prev.some((p) => resultKey(p) === id && id !== '') ? prev : [...prev, item],
        );
      } catch {
        /* 单条数据异常不影响后续条目 */
      }
    };
    es.onerror = () => {
      // 服务端正常结束也会触发 onerror；只有从未打开过才算失败
      if (esRef.current !== es) {
        es.close();
        return;
      }
      setStatus((prev) => (prev === 'connecting' ? 'failed' : 'done'));
      closeStream();
    };
  }

  async function onSubscribe(item: Partial<Bangumi>) {
    const key = resultKey(item);
    setSubscribingKey(key);
    try {
      const res = await apiRss.subscribe(item, site);
      void message.success(msgZh(res, '订阅成功'));
    } catch {
      void message.error('订阅失败');
    } finally {
      setSubscribingKey(null);
    }
  }

  const searching = status === 'connecting' || status === 'open';

  return (
    <Modal
      open={open}
      title="搜索番剧"
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnClose
    >
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Select
          value={site || undefined}
          placeholder="站点"
          options={providers.map((p) => ({ value: p, label: p }))}
          onChange={setSite}
          style={{ width: 140 }}
        />
        <Input.Search
          value={keyword}
          placeholder="输入关键字搜索"
          enterButton="搜索"
          allowClear
          loading={searching}
          onChange={(e) => setKeyword(e.target.value)}
          onSearch={() => startSearch()}
        />
      </Space.Compact>

      {status === 'failed' ? (
        <Empty description="搜索失败，请检查连接后重试。" />
      ) : results.length === 0 ? (
        <Empty
          description={
            searching ? (
              <Space>
                <Spin size="small" /> 搜索中…
              </Space>
            ) : keyword.trim() ? (
              '未找到相关结果，试试其他关键词'
            ) : (
              '输入关键词开始搜索'
            )
          }
        />
      ) : (
        <div
          style={{
            maxHeight: '55vh',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {results.map((item) => {
            const key = resultKey(item);
            return (
              <div
                key={key || Math.random()}
                style={{
                  display: 'flex',
                  gap: 12,
                  padding: 12,
                  border: '1px solid rgba(128, 128, 128, 0.25)',
                  borderRadius: 8,
                }}
              >
                <div
                  style={{
                    width: 60,
                    height: 84,
                    flexShrink: 0,
                    borderRadius: 6,
                    overflow: 'hidden',
                    background: 'rgba(0, 0, 0, 0.05)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {item.poster_link ? (
                    <img
                      src={resolvePosterUrl(item.poster_link)}
                      alt={item.official_title ?? ''}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <PictureOutlined style={{ fontSize: 20, color: '#999' }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Typography.Text strong ellipsis style={{ display: 'block' }}>
                    {item.official_title || item.title_raw || '未命名'}
                  </Typography.Text>
                  <Space size={4} wrap style={{ marginTop: 6 }}>
                    {item.group_name && <Tag color="blue">{item.group_name}</Tag>}
                    {item.dpi && <Tag color="green">{item.dpi}</Tag>}
                    {item.subtitle && <Tag color="orange">{item.subtitle}</Tag>}
                    {(item.season_raw || item.season) && (
                      <Tag color="purple">{item.season_raw || `S${item.season}`}</Tag>
                    )}
                    {item.year && <Tag>{item.year}</Tag>}
                  </Space>
                </div>
                <div style={{ alignSelf: 'center', flexShrink: 0 }}>
                  <Button
                    type="primary"
                    size="small"
                    loading={subscribingKey === key}
                    onClick={() => void onSubscribe(item)}
                  >
                    订阅
                  </Button>
                </div>
              </div>
            );
          })}
          {searching && (
            <div style={{ textAlign: 'center', padding: 8 }}>
              <Spin size="small" /> <Typography.Text type="secondary">结果持续加载中…</Typography.Text>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
