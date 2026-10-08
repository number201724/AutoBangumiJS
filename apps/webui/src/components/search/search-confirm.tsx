/**
 * 搜索订阅确认弹窗 — 移植自 Vue 版 ab-search-confirm.vue：
 * 预览（海报/official_title/title_raw/year + 季度/分辨率/字幕/字幕组标签 + RSS 链接复制）、
 * 高级设置（filter 标签、season_offset/episode_offset、air_weekday、episode_type、
 * preferred_group、preferred_resolution，字段实现对齐 bangumi/edit-rule-modal.tsx）、
 * 打开时自动 apiBangumi.detectOffset，不匹配时弹 OffsetMismatchDialog（应用/保持/取消）、
 * 「收集」/「订阅」按钮（apiRss.collect/subscribe）成功后 toast + 刷新番剧列表并关闭。
 * 错误提示统一交给 axios 拦截器（对齐 stores/bangumi.ts 约定）。
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AutoComplete,
  Button,
  Col,
  Collapse,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Tag,
  Typography,
  message,
} from 'antd';
import { CheckOutlined, CopyOutlined, FileImageOutlined } from '@ant-design/icons';
import type { Bangumi } from '@ab/types';

import { apiBangumi } from '@/api/bangumi';
import { apiRss } from '@/api/rss';
import { useBangumiStore } from '@/stores/bangumi';
import { useSearchStore, type SearchVariant } from '@/stores/search';
import {
  OffsetMismatchDialog,
  type OffsetSuggestion,
  type TmdbInfo,
} from '@/components/bangumi/offset-mismatch-dialog';
import { WEEKDAY_FULL, msgOf, resolvePosterUrl } from '@/components/bangumi/utils';

const RESOLUTION_PRESETS = ['2160p', '1080p', '720p'].map((r) => ({ value: r }));

const EPISODE_TYPE_OPTIONS = [
  { label: '剧集', value: 'episode' },
  { label: '剧场版', value: 'movie' },
  { label: '特别篇', value: 'special' },
];

const WEEKDAY_OPTIONS = WEEKDAY_FULL.map((label, value) => ({ label, value }));

const FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'rgba(0,0,0,0.65)',
};

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Row align="middle" style={{ minHeight: 32 }}>
      <Col flex="96px" style={FIELD_LABEL_STYLE}>
        {label}
      </Col>
      <Col flex={1} style={{ textAlign: 'right' }}>
        {children}
      </Col>
    </Row>
  );
}

/** SearchVariant → 后端订阅/收集负载（filter/rss_link 数组合回逗号分隔字符串） */
function toPayload(b: SearchVariant): Partial<Bangumi> {
  return {
    ...b,
    filter: b.filter.join(','),
    rss_link: b.rss_link.join(','),
    season_offset: b.season_offset ?? 0,
    episode_offset: b.episode_offset ?? 0,
  };
}

export function SearchConfirm() {
  const selected = useSearchStore((s) => s.selectedResult);
  const provider = useSearchStore((s) => s.provider);
  const selectResult = useSearchStore((s) => s.selectResult);
  const closeModal = useSearchStore((s) => s.closeModal);

  // 本地深拷贝，避免直接改 store 里的对象（对应 Vue localBangumi）
  const [local, setLocal] = useState<SearchVariant | null>(null);
  const [copied, setCopied] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [subscribing, setSubscribing] = useState(false);

  // detect-offset 状态
  const [showOffsetDialog, setShowOffsetDialog] = useState(false);
  const [offsetSuggestion, setOffsetSuggestion] = useState<OffsetSuggestion | null>(null);
  const [tmdbInfo, setTmdbInfo] = useState<TmdbInfo | null>(null);

  // 打开/切换变体时重置本地状态并自动 detectOffset（不匹配才弹提示）
  useEffect(() => {
    if (!selected) {
      setLocal(null);
      return;
    }
    const copy = JSON.parse(JSON.stringify(selected)) as SearchVariant;
    setLocal(copy);
    setCopied(false);
    setShowOffsetDialog(false);
    setOffsetSuggestion(null);
    setTmdbInfo(null);

    if (!copy.official_title || !copy.season) return;
    void (async () => {
      try {
        // 以第 1 集为基线检测
        const result = await apiBangumi.detectOffset(copy.official_title, copy.season, 1);
        // 检测返回时弹窗可能已切换目标/已关闭：以当前选中为准，防串台
        if (useSearchStore.getState().selectedResult !== selected) return;
        if (result.has_mismatch && result.suggestion) {
          setOffsetSuggestion(result.suggestion);
          setTmdbInfo(result.tmdb_info);
          setShowOffsetDialog(true);
        }
      } catch (e) {
        console.error('Failed to detect offset mismatch:', e);
      }
    })();
  }, [selected]);

  const patch = (p: Partial<SearchVariant>) =>
    setLocal((l) => (l ? { ...l, ...p } : l));

  const infoTags = useMemo(() => {
    if (!local) return [];
    const tags: { key: string; text: string; color: string }[] = [];
    if (local.season || local.season_raw) {
      tags.push({
        key: 'season',
        text: local.season_raw || `S${local.season}`,
        color: 'blue',
      });
    }
    if (local.dpi) tags.push({ key: 'dpi', text: local.dpi, color: 'cyan' });
    if (local.subtitle) tags.push({ key: 'subtitle', text: local.subtitle, color: 'green' });
    if (local.group_name) tags.push({ key: 'group', text: local.group_name, color: 'orange' });
    return tags;
  }, [local]);

  async function copyRssLink() {
    const rssLink = local?.rss_link[0];
    if (!rssLink) return;
    try {
      await navigator.clipboard.writeText(rssLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      void message.error('您的浏览器不支持剪贴板操作!');
    }
  }

  function handleOffsetApply(offsets: { seasonOffset: number; episodeOffset: number }) {
    patch({
      season_offset: offsets.seasonOffset,
      episode_offset: offsets.episodeOffset,
    });
    setShowOffsetDialog(false);
  }

  /** 成功后的公共收尾：toast + 刷新番剧列表 + 关闭确认与搜索弹窗 */
  async function finishSuccess(res: unknown, fallback: string) {
    void message.success(msgOf(res, fallback));
    await useBangumiStore.getState().getAll();
    selectResult(null);
    closeModal();
  }

  async function handleCollect() {
    if (!local) return;
    setCollecting(true);
    try {
      const res = await apiRss.collect(toPayload(local));
      await finishSuccess(res, '收集成功');
    } catch (e) {
      // 错误提示已由 axios 拦截器弹出
      console.error('Collect failed:', e);
    } finally {
      setCollecting(false);
    }
  }

  async function handleSubscribe() {
    if (!local) return;
    setSubscribing(true);
    try {
      // 对应 Vue subscribe(bangumi, rss.parser=provider)：站点名由后端映射为解析器
      const res = await apiRss.subscribe(toPayload(local), provider);
      await finishSuccess(res, '订阅成功');
    } catch (e) {
      // 错误提示已由 axios 拦截器弹出
      console.error('Subscribe failed:', e);
    } finally {
      setSubscribing(false);
    }
  }

  if (!selected) return null;

  return (
    <>
      <Modal
        open
        title="添加订阅"
        width={480}
        onCancel={() => selectResult(null)}
        footer={
          <>
            <Button size="small" onClick={() => selectResult(null)}>
              取消
            </Button>
            <Button
              size="small"
              loading={collecting}
              disabled={subscribing}
              onClick={() => void handleCollect()}
            >
              收集
            </Button>
            <Button
              size="small"
              type="primary"
              loading={subscribing}
              disabled={collecting}
              onClick={() => void handleSubscribe()}
            >
              订阅
            </Button>
          </>
        }
      >
        {local && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* 预览：海报 + 标题/原始标题/年份 */}
            <div style={{ display: 'flex', gap: 16 }}>
              <div className="search-confirm-poster">
                {local.poster_link ? (
                  <img src={resolvePosterUrl(local.poster_link)} alt={local.official_title} />
                ) : (
                  <div className="search-confirm-poster-placeholder">
                    <FileImageOutlined />
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>
                  {local.official_title}
                </Typography.Title>
                {local.title_raw && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                    {local.title_raw}
                  </Typography.Text>
                )}
                {local.year && (
                  <div style={{ marginTop: 4 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      {local.year}
                    </Typography.Text>
                  </div>
                )}
              </div>
            </div>

            {/* 信息标签：季度/分辨率/字幕/字幕组 */}
            {infoTags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {infoTags.map((t) => (
                  <Tag key={t.key} color={t.color} style={{ marginInlineEnd: 0 }}>
                    {t.text}
                  </Tag>
                ))}
              </div>
            )}

            {/* RSS 链接 */}
            <div
              style={{
                padding: '10px 16px',
                background: 'rgba(0,0,0,0.03)',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Typography.Text type="secondary" style={{ flexShrink: 0, fontSize: 13 }}>
                RSS 源：
              </Typography.Text>
              <Typography.Text
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  color: '#1677ff',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {local.rss_link[0] || '-'}
              </Typography.Text>
              <Button
                size="small"
                type="text"
                aria-label="复制 RSS 链接"
                icon={copied ? <CheckOutlined style={{ color: '#52c41a' }} /> : <CopyOutlined />}
                onClick={() => void copyRssLink()}
              />
            </div>

            {/* 高级设置 */}
            <Collapse
              ghost
              items={[
                {
                  key: 'advanced',
                  label: '高级设置',
                  children: (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <FieldRow label="过滤规则">
                        <Select
                          mode="tags"
                          open={false}
                          suffixIcon={null}
                          placeholder="输入后回车添加过滤词"
                          style={{ width: '100%' }}
                          value={local.filter}
                          onChange={(tags) => patch({ filter: tags })}
                        />
                      </FieldRow>
                      <FieldRow label="季度偏移">
                        <InputNumber
                          value={local.season_offset ?? 0}
                          style={{ width: 90 }}
                          onChange={(v) => patch({ season_offset: v ?? 0 })}
                        />
                      </FieldRow>
                      <FieldRow label="集数偏移">
                        <InputNumber
                          value={local.episode_offset ?? 0}
                          style={{ width: 90 }}
                          onChange={(v) => patch({ episode_offset: v ?? 0 })}
                        />
                      </FieldRow>
                      <FieldRow label="放送星期">
                        <Select
                          value={local.air_weekday ?? undefined}
                          options={WEEKDAY_OPTIONS}
                          allowClear
                          placeholder="未知"
                          style={{ width: 160 }}
                          onChange={(v?: number) =>
                            patch({ air_weekday: v ?? null, weekday_locked: v != null })
                          }
                        />
                      </FieldRow>
                      <FieldRow label="内容类型">
                        <Select
                          value={local.episode_type ?? 'episode'}
                          options={EPISODE_TYPE_OPTIONS}
                          style={{ width: 160 }}
                          onChange={(v) => patch({ episode_type: v })}
                        />
                      </FieldRow>
                      <FieldRow label="偏好字幕组">
                        <Input
                          value={local.preferred_group ?? ''}
                          placeholder="ANi"
                          style={{ width: 160 }}
                          onChange={(e) => patch({ preferred_group: e.target.value || null })}
                        />
                      </FieldRow>
                      <FieldRow label="偏好分辨率">
                        <AutoComplete
                          value={local.preferred_resolution ?? ''}
                          options={RESOLUTION_PRESETS}
                          placeholder="自动检测"
                          allowClear
                          style={{ width: 160 }}
                          onChange={(v) => patch({ preferred_resolution: v || null })}
                        />
                      </FieldRow>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Modal>

      {/* 季度/集数不匹配提示（detectOffset 打开时自动检测） */}
      <OffsetMismatchDialog
        open={showOffsetDialog}
        bangumiTitle={local?.official_title ?? ''}
        parsedSeason={local?.season ?? 1}
        parsedEpisode={1}
        tmdbInfo={tmdbInfo}
        suggestion={offsetSuggestion}
        onApply={handleOffsetApply}
        onKeep={() => setShowOffsetDialog(false)}
        onCancel={() => setShowOffsetDialog(false)}
      />
    </>
  );
}
