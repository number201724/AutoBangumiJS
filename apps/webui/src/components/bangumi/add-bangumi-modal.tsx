/**
 * 添加 RSS 弹窗 — 移植自 Vue 版 ab-add-rss.vue。
 * 两步：输入 RSS 链接（聚合开关/解析器）→ analysis 解析 → 确认页编辑后
 * 「收集」（旧番补全）或「订阅」（新番）。确认页挂载时自动 detectOffset，
 * 有不匹配则弹出 OffsetMismatchDialog（对应 ab-search-confirm.vue 的流程）。
 */
import { useEffect, useMemo, useState } from 'react';
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
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { FileImageOutlined, LinkOutlined } from '@ant-design/icons';
import type { Bangumi } from '@ab/types';

import { apiBangumi } from '@/api/bangumi';
import { apiRss } from '@/api/rss';
import { useBangumiStore } from '@/stores/bangumi';
import {
  OffsetMismatchDialog,
  type OffsetSuggestion,
  type TmdbInfo,
} from './offset-mismatch-dialog';
import { filterToTags, msgOf, resolvePosterUrl, tagsToFilter } from './utils';

interface AddBangumiModalProps {
  open: boolean;
  onClose: () => void;
}

const PARSER_TYPES = ['tmdb', 'mikan', 'parser', 'ani'] as const;
const RESOLUTION_PRESETS = ['2160p', '1080p', '720p'].map((r) => ({ value: r }));

/** analysis 返回的番剧草稿默认值（对应 Vue ruleTemplate） */
const DRAFT_TEMPLATE: Partial<Bangumi> = {
  official_title: '',
  title_raw: '',
  year: null,
  season: 1,
  season_raw: null,
  group_name: null,
  dpi: null,
  source: null,
  subtitle: null,
  eps_collect: false,
  episode_offset: 0,
  season_offset: 0,
  filter: '',
  rss_link: '',
  poster_link: null,
  episode_type: 'episode',
};

export function AddBangumiModal({ open, onClose }: AddBangumiModalProps) {
  const getAll = useBangumiStore((s) => s.getAll);

  // 第一步：RSS 输入
  const [rssUrl, setRssUrl] = useState('');
  const [rssName, setRssName] = useState('');
  const [aggregate, setAggregate] = useState(false);
  const [parser, setParser] = useState<string>('tmdb');

  const [step, setStep] = useState<'input' | 'confirm'>('input');
  const [draft, setDraft] = useState<Partial<Bangumi>>({ ...DRAFT_TEMPLATE });

  const [analyzing, setAnalyzing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [copied, setCopied] = useState(false);

  // 偏移检测（对应 ab-search-confirm 的 detectOffsetMismatch）
  const [offsetDialogOpen, setOffsetDialogOpen] = useState(false);
  const [offsetSuggestion, setOffsetSuggestion] = useState<OffsetSuggestion | null>(null);
  const [tmdbInfo, setTmdbInfo] = useState<TmdbInfo | null>(null);

  // 关闭时重置状态（对应 Vue watch(show)）
  useEffect(() => {
    if (!open) {
      setRssUrl('');
      setRssName('');
      setAggregate(false);
      setParser('tmdb');
      setStep('input');
      setDraft({ ...DRAFT_TEMPLATE });
      setOffsetDialogOpen(false);
      setOffsetSuggestion(null);
      setTmdbInfo(null);
    }
  }, [open]);

  const patchDraft = (p: Partial<Bangumi>) => setDraft((d) => ({ ...d, ...p }));

  const rssLink = useMemo(() => draft.rss_link || rssUrl || '', [draft.rss_link, rssUrl]);

  async function detectOffsetMismatch(d: Partial<Bangumi>) {
    if (!d.official_title || !d.season) return;
    try {
      const result = await apiBangumi.detectOffset(d.official_title, d.season, 1);
      if (result.has_mismatch && result.suggestion) {
        setOffsetSuggestion(result.suggestion);
        setTmdbInfo(result.tmdb_info);
        setOffsetDialogOpen(true);
      }
    } catch {
      // 检测失败不阻塞订阅流程
    }
  }

  /** 添加按钮：聚合 RSS 直接入库；单链先 analysis 进确认页 */
  async function handleAdd() {
    if (!rssUrl) {
      void message.error('请输入RSS链接!');
      return;
    }
    setAnalyzing(true);
    try {
      if (aggregate) {
        const res = await apiRss.add({
          url: rssUrl,
          name: rssName || null,
          aggregate: true,
          parser,
        });
        void message.success(msgOf(res, '已添加聚合 RSS。'));
        onClose();
      } else {
        const res = await apiRss.analysis(rssUrl, parser);
        const parsed = { ...DRAFT_TEMPLATE, ...(res as Partial<Bangumi>) };
        setDraft(parsed);
        setStep('confirm');
        void detectOffsetMismatch(parsed);
      }
    } catch {
      // 错误提示由 axios 拦截器统一弹出
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleCollect() {
    setCollecting(true);
    try {
      const res = await apiRss.collect({ ...draft, rss_link: rssLink });
      void message.success(msgOf(res, '收集任务已创建。'));
      await getAll();
      onClose();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setCollecting(false);
    }
  }

  async function handleSubscribe() {
    setSubscribing(true);
    try {
      const res = await apiRss.subscribe({ ...draft, rss_link: rssLink }, parser);
      void message.success(msgOf(res, '订阅成功'));
      await getAll();
      onClose();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSubscribing(false);
    }
  }

  async function copyRssLink() {
    if (!rssLink) return;
    try {
      await navigator.clipboard.writeText(rssLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      void message.error('您的浏览器不支持剪贴板操作!');
    }
  }

  const infoTags = useMemo(() => {
    const tags: { key: string; text: string; color: string }[] = [];
    if (draft.episode_type === 'movie' || draft.episode_type === 'special') {
      tags.push({
        key: 'etype',
        text: draft.episode_type === 'movie' ? '剧场版' : '特别篇',
        color: 'purple',
      });
    }
    if (draft.season || draft.season_raw) {
      tags.push({
        key: 'season',
        text: draft.season_raw || `S${draft.season}`,
        color: 'blue',
      });
    }
    if (draft.dpi) tags.push({ key: 'dpi', text: draft.dpi, color: 'cyan' });
    if (draft.subtitle) tags.push({ key: 'subtitle', text: draft.subtitle, color: 'green' });
    if (draft.group_name) tags.push({ key: 'group', text: draft.group_name, color: 'orange' });
    return tags;
  }, [draft]);

  return (
    <Modal
      open={open}
      title="添加 RSS"
      width={560}
      onCancel={onClose}
      footer={
        step === 'input' ? (
          <Button type="primary" size="small" loading={analyzing} onClick={() => void handleAdd()}>
            添加
          </Button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="small" style={{ marginRight: 'auto' }} onClick={() => setStep('input')}>
              上一步
            </Button>
            <Button
              size="small"
              type="primary"
              loading={collecting}
              onClick={() => void handleCollect()}
            >
              收集
            </Button>
            <Button
              size="small"
              type="primary"
              loading={subscribing}
              onClick={() => void handleSubscribe()}
            >
              订阅
            </Button>
          </div>
        )
      }
    >
      {step === 'input' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 500 }}>
              RSS 链接
            </Typography.Text>
            <Input
              style={{ marginTop: 8 }}
              prefix={<LinkOutlined style={{ color: 'rgba(0,0,0,0.25)' }} />}
              placeholder="请输入 RSS 链接"
              value={rssUrl}
              onChange={(e) => setRssUrl(e.target.value)}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 500 }}>
              名称
            </Typography.Text>
            <Input
              style={{ marginTop: 8 }}
              placeholder="可选"
              value={rssName}
              onChange={(e) => setRssName(e.target.value)}
            />
          </div>
          <Row
            align="middle"
            style={{
              padding: 16,
              background: 'rgba(0,0,0,0.03)',
              borderRadius: 8,
            }}
            gutter={16}
          >
            <Col flex={1}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 500 }}>
                  聚合 RSS
                </Typography.Text>
                <Switch checked={aggregate} onChange={setAggregate} />
              </div>
            </Col>
            <Col>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 500 }}>
                  解析器
                </Typography.Text>
                <Select
                  value={parser}
                  style={{ width: 140 }}
                  options={PARSER_TYPES.map((p) => ({ label: p, value: p }))}
                  onChange={setParser}
                />
              </div>
            </Col>
          </Row>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 预览 */}
          <div style={{ display: 'flex', gap: 16 }}>
            <div className="bgm-edit-poster">
              {draft.poster_link ? (
                <img src={resolvePosterUrl(draft.poster_link)} alt={draft.official_title} />
              ) : (
                <div className="bgm-poster-placeholder" style={{ height: '100%' }}>
                  <FileImageOutlined />
                </div>
              )}
            </div>
            <div
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <Input
                value={draft.official_title}
                placeholder="官方名称"
                onChange={(e) => patchDraft({ official_title: e.target.value })}
              />
              {draft.title_raw && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                  {draft.title_raw}
                </Typography.Text>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Input
                  value={draft.year ?? ''}
                  placeholder="年份"
                  style={{ width: 110 }}
                  onChange={(e) => patchDraft({ year: e.target.value || null })}
                />
                <span>·</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>S</span>
                <InputNumber
                  value={draft.season}
                  min={1}
                  style={{ width: 90 }}
                  onChange={(v) => patchDraft({ season: v ?? 1 })}
                />
              </div>
            </div>
          </div>

          {/* 信息标签 */}
          {infoTags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {infoTags.map((t) => (
                <Tag key={t.key} color={t.color} style={{ marginInlineEnd: 0 }}>
                  {t.text}
                </Tag>
              ))}
            </div>
          )}

          {/* RSS 源 */}
          {rssLink && (
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
                  color: '#1890ff',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {rssLink}
              </Typography.Text>
              <Button size="small" type="text" onClick={() => void copyRssLink()}>
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
          )}

          {/* 高级设置 */}
          <Collapse
            ghost
            items={[
              {
                key: 'advanced',
                label: '高级设置',
                children: (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Row align="middle">
                      <Col flex="96px" style={{ fontSize: 13, fontWeight: 500 }}>
                        过滤规则
                      </Col>
                      <Col flex={1}>
                        <Select
                          mode="tags"
                          open={false}
                          suffixIcon={null}
                          placeholder="用于排除不需要的种子，支持正则表达式"
                          style={{ width: '100%' }}
                          value={filterToTags(draft.filter)}
                          onChange={(tags) => patchDraft({ filter: tagsToFilter(tags) })}
                        />
                      </Col>
                    </Row>
                    <Row align="middle">
                      <Col flex="96px" style={{ fontSize: 13, fontWeight: 500 }}>
                        分辨率
                      </Col>
                      <Col flex={1}>
                        <AutoComplete
                          value={draft.dpi ?? ''}
                          options={RESOLUTION_PRESETS}
                          style={{ width: '100%' }}
                          onChange={(v) => patchDraft({ dpi: v || null })}
                        />
                      </Col>
                    </Row>
                    <Row align="middle">
                      <Col flex="96px" style={{ fontSize: 13, fontWeight: 500 }}>
                        季度偏移
                      </Col>
                      <Col flex={1}>
                        <InputNumber
                          value={draft.season_offset ?? 0}
                          style={{ width: 90 }}
                          onChange={(v) => patchDraft({ season_offset: v ?? 0 })}
                        />
                      </Col>
                    </Row>
                    <Row align="middle">
                      <Col flex="96px" style={{ fontSize: 13, fontWeight: 500 }}>
                        集数偏移
                      </Col>
                      <Col flex={1}>
                        <InputNumber
                          value={draft.episode_offset ?? 0}
                          style={{ width: 90 }}
                          onChange={(v) => patchDraft({ episode_offset: v ?? 0 })}
                        />
                      </Col>
                    </Row>
                    <Row align="middle">
                      <Col flex="96px" style={{ fontSize: 13, fontWeight: 500 }}>
                        收集全集
                      </Col>
                      <Col flex={1}>
                        <Switch
                          checked={draft.eps_collect ?? false}
                          onChange={(v) => patchDraft({ eps_collect: v })}
                        />
                      </Col>
                    </Row>
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      {/* 偏移不匹配确认（analysis 后自动检测触发） */}
      <OffsetMismatchDialog
        open={offsetDialogOpen}
        bangumiTitle={draft.official_title ?? ''}
        parsedSeason={draft.season ?? 1}
        parsedEpisode={1}
        tmdbInfo={tmdbInfo}
        suggestion={offsetSuggestion}
        onApply={({ seasonOffset, episodeOffset }) => {
          patchDraft({ season_offset: seasonOffset, episode_offset: episodeOffset });
          setOffsetDialogOpen(false);
        }}
        onKeep={() => setOffsetDialogOpen(false)}
        onCancel={() => setOffsetDialogOpen(false)}
      />
    </Modal>
  );
}
