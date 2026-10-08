/**
 * 编辑规则弹窗 — 移植自 Vue 版 ab-edit-rule.vue。
 * 覆盖：预览（海报/标题/年份/季度）、信息标签、RSS 链接复制、
 * 基础字段（title_raw/group_name/dpi/subtitle/source/rss_link/title_aliases/
 * eps_collect）、高级设置（filter/偏移/放送星期/内容类型/偏好）、
 * needs-review 横幅（自动检测/忽略）、删除/禁用（可选连带删除文件）、
 * 归档/取消归档、刷新海报、查看种子；deleted 规则退化为启用确认框。
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
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
import { FileImageOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { Bangumi } from '@ab/types';

import { apiBangumi } from '@/api/bangumi';
import { useBangumiStore } from '@/stores/bangumi';
import {
  WEEKDAY_FULL,
  filterToTags,
  resolvePosterUrl,
  tagsToFilter,
} from './utils';

interface EditRuleModalProps {
  rule: Bangumi | null;
  open: boolean;
  onClose: () => void;
}

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

export function EditRuleModal({ rule, open, onClose }: EditRuleModalProps) {
  const navigate = useNavigate();
  const {
    updateRule,
    enableRule,
    disableRule,
    deleteRule,
    refreshPoster,
    archiveRule,
    unarchiveRule,
  } = useBangumiStore();

  // 本地深拷贝，避免直接改 store 里的对象（对应 Vue localRule）
  const [local, setLocal] = useState<Bangumi | null>(null);
  useEffect(() => {
    if (open && rule) {
      setLocal(JSON.parse(JSON.stringify(rule)) as Bangumi);
      setOffsetReason('');
      setDeleteDialog({ show: false, type: 'delete' });
      setDeleteFiles(false);
    }
  }, [open, rule]);

  const [offsetLoading, setOffsetLoading] = useState(false);
  const [offsetReason, setOffsetReason] = useState('');
  const [dismissing, setDismissing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  // 删除/禁用的连带文件确认框
  const [deleteDialog, setDeleteDialog] = useState<{
    show: boolean;
    type: 'disable' | 'delete';
  }>({ show: false, type: 'delete' });
  const [deleteFiles, setDeleteFiles] = useState(false);

  const patch = (p: Partial<Bangumi>) =>
    setLocal((l) => (l ? { ...l, ...p } : l));

  const infoTags = useMemo(() => {
    if (!local) return [];
    const tags: { key: string; text: string; color: string }[] = [];
    if (local.episode_type === 'movie' || local.episode_type === 'special') {
      tags.push({
        key: 'etype',
        text: local.episode_type === 'movie' ? '剧场版' : '特别篇',
        color: 'purple',
      });
    }
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

  if (!rule) return null;
  // 常量绑定以便闭包内保留非空收窄（TS 不为参数保留闭包收窄）
  const current = rule;

  /** 自动检测偏移（detectOffset，无需已入库 id） */
  async function autoDetectOffset() {
    if (!local?.official_title || !local.season) return;
    setOffsetLoading(true);
    setOffsetReason('');
    try {
      const result = await apiBangumi.detectOffset(local.official_title, local.season, 1);
      if (result.has_mismatch && result.suggestion) {
        patch({
          season_offset: result.suggestion.season_offset,
          episode_offset: result.suggestion.episode_offset,
          needs_review: false,
          needs_review_reason: null,
        });
        setOffsetReason(result.suggestion.reason);
        void message.success('偏移量建议已应用');
      } else {
        setOffsetReason('未检测到季度/集数不匹配');
        patch({ needs_review: false, needs_review_reason: null });
        void message.info('未检测到季度/集数不匹配');
      }
    } catch {
      void message.error('检测偏移量失败');
    } finally {
      setOffsetLoading(false);
    }
  }

  /** 忽略 needs_review 提醒 */
  async function dismissReview() {
    if (!local?.id) return;
    setDismissing(true);
    try {
      await apiBangumi.dismissReview(local.id);
      patch({ needs_review: false, needs_review_reason: null });
      void message.success('检查提醒已忽略');
    } catch {
      void message.error('忽略检查提醒失败');
    } finally {
      setDismissing(false);
    }
  }

  async function copyRssLink() {
    if (!local?.rss_link) return;
    try {
      await navigator.clipboard.writeText(local.rss_link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      void message.error('您的浏览器不支持剪贴板操作!');
    }
  }

  /** 应用：按任务字段清单构造 payload（filter 已是逗号分隔字符串） */
  async function handleApply() {
    if (!local) return;
    setBusy(true);
    const payload: Partial<Bangumi> = {
      official_title: local.official_title,
      title_raw: local.title_raw,
      year: local.year,
      season: local.season,
      group_name: local.group_name,
      dpi: local.dpi,
      subtitle: local.subtitle,
      source: local.source,
      filter: local.filter,
      rss_link: local.rss_link,
      eps_collect: local.eps_collect,
      episode_offset: local.episode_offset,
      season_offset: local.season_offset,
      air_weekday: local.air_weekday,
      weekday_locked: local.weekday_locked,
      title_aliases: local.title_aliases,
      preferred_group: local.preferred_group,
      preferred_resolution: local.preferred_resolution,
      episode_type: local.episode_type,
    
      needs_review: local.needs_review,
      needs_review_reason: local.needs_review_reason,
    };
    const ok = await updateRule(current.id, payload);
    setBusy(false);
    if (ok) onClose();
  }

  async function handleEnable() {
    setBusy(true);
    const ok = await enableRule(current.id);
    setBusy(false);
    if (ok) onClose();
  }

  async function handleDeleteConfirm() {
    setBusy(true);
    const ok =
      deleteDialog.type === 'delete'
        ? await deleteRule(current.id, deleteFiles)
        : await disableRule(current.id, deleteFiles);
    setBusy(false);
    if (ok) {
      setDeleteDialog({ show: false, type: 'delete' });
      onClose();
    }
  }

  async function handleArchive() {
    setBusy(true);
    const ok = local?.archived
      ? await unarchiveRule(current.id)
      : await archiveRule(current.id);
    setBusy(false);
    if (ok) onClose();
  }

  async function handleRefreshPoster() {
    setBusy(true);
    const ok = await refreshPoster(current.id);
    setBusy(false);
    if (ok) onClose();
  }

  function goToTorrents() {
    onClose();
    void navigate(`/bangumi-torrents/${current.id}`);
  }

  // deleted 规则：只给“启用规则”确认框（对应 Vue 版 v-if="rule.deleted" 分支）
  if (current.deleted) {
    return (
      <Modal
        open={open}
        title="启用规则"
        onCancel={onClose}
        footer={
          <>
            <Button size="small" onClick={onClose}>
              否
            </Button>
            <Button size="small" type="primary" loading={busy} onClick={() => void handleEnable()}>
              是
            </Button>
          </>
        }
      >
        确定启用该规则？
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      title="编辑规则"
      width={640}
      onCancel={onClose}
      footer={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button size="small" onClick={goToTorrents}>
            查看种子
          </Button>
          <Button size="small" loading={busy} onClick={() => void handleRefreshPoster()}>
            刷新海报
          </Button>
          <span style={{ flex: 1 }} />
          <Button
            size="small"
            onClick={() => {
              setDeleteFiles(false);
              setDeleteDialog({ show: true, type: 'disable' });
            }}
          >
            禁用
          </Button>
          <Button size="small" loading={busy} onClick={() => void handleArchive()}>
            {local?.archived ? '取消归档' : '归档'}
          </Button>
          <Button
            size="small"
            danger
            onClick={() => {
              setDeleteFiles(false);
              setDeleteDialog({ show: true, type: 'delete' });
            }}
          >
            删除
          </Button>
          <Button size="small" type="primary" loading={busy} onClick={() => void handleApply()}>
            应用
          </Button>
        </div>
      }
    >
      {local && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* needs-review 警告横幅 */}
          {local.needs_review && (
            <Alert
              type="warning"
              showIcon
              message="需要检查偏移量"
              description={
                local.needs_review_reason && (
                  <span style={{ fontSize: 12 }}>{local.needs_review_reason}</span>
                )
              }
              action={
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    size="small"
                    type="primary"
                    loading={offsetLoading}
                    onClick={() => void autoDetectOffset()}
                  >
                    自动检测
                  </Button>
                  <Button size="small" loading={dismissing} onClick={() => void dismissReview()}>
                    忽略
                  </Button>
                </div>
              }
            />
          )}

          {/* 预览：海报 + 标题/年份/季度 */}
          <div style={{ display: 'flex', gap: 16 }}>
            <div className="bgm-edit-poster">
              {local.poster_link ? (
                <img src={resolvePosterUrl(local.poster_link)} alt={local.official_title} />
              ) : (
                <div className="bgm-poster-placeholder" style={{ height: '100%' }}>
                  <FileImageOutlined />
                </div>
              )}
            </div>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <Input
                value={local.official_title}
                placeholder="官方名称"
                aria-label="官方名称"
                onChange={(e) => patch({ official_title: e.target.value })}
              />
              {local.title_raw && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                  {local.title_raw}
                </Typography.Text>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Input
                  value={local.year ?? ''}
                  placeholder="年份"
                  aria-label="年份"
                  style={{ width: 110 }}
                  onChange={(e) => patch({ year: e.target.value || null })}
                />
                <span>·</span>
                <span style={FIELD_LABEL_STYLE}>S</span>
                <InputNumber
                  value={local.season}
                  min={1}
                  aria-label="季度"
                  style={{ width: 90 }}
                  onChange={(v) => patch({ season: v ?? 1 })}
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

          {/* RSS 链接 */}
          {local.rss_link && (
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
                {local.rss_link}
              </Typography.Text>
              <Button size="small" type="text" onClick={() => void copyRssLink()}>
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
          )}

          {/* 基础字段 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <FieldRow label="原始标题">
              <Input
                value={local.title_raw}
                onChange={(e) => patch({ title_raw: e.target.value })}
              />
            </FieldRow>
            <FieldRow label="字幕组">
              <Input
                value={local.group_name ?? ''}
                onChange={(e) => patch({ group_name: e.target.value || null })}
              />
            </FieldRow>
            <FieldRow label="分辨率">
              <AutoComplete
                value={local.dpi ?? ''}
                options={RESOLUTION_PRESETS}
                style={{ width: '100%' }}
                onChange={(v) => patch({ dpi: v || null })}
              />
            </FieldRow>
            <FieldRow label="字幕">
              <Input
                value={local.subtitle ?? ''}
                onChange={(e) => patch({ subtitle: e.target.value || null })}
              />
            </FieldRow>
            <FieldRow label="来源">
              <Input
                value={local.source ?? ''}
                onChange={(e) => patch({ source: e.target.value || null })}
              />
            </FieldRow>
            <FieldRow label="RSS 链接">
              <Input
                value={local.rss_link}
                onChange={(e) => patch({ rss_link: e.target.value })}
              />
            </FieldRow>
            <FieldRow label="标题别名">
              <Input
                value={local.title_aliases ?? ''}
                placeholder="多个别名用逗号分隔"
                onChange={(e) => patch({ title_aliases: e.target.value || null })}
              />
            </FieldRow>
            <FieldRow label="收集全集">
              <Switch
                checked={local.eps_collect}
                onChange={(v) => patch({ eps_collect: v })}
              />
            </FieldRow>
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
                    <FieldRow label="过滤">
                      <Select
                        mode="tags"
                        open={false}
                        suffixIcon={null}
                        placeholder="输入后回车添加过滤词"
                        style={{ width: '100%' }}
                        value={filterToTags(local.filter)}
                        onChange={(tags) => patch({ filter: tagsToFilter(tags) })}
                      />
                    </FieldRow>
                    <FieldRow label="季度偏移">
                      <InputNumber
                        value={local.season_offset}
                        style={{ width: 90 }}
                        onChange={(v) => patch({ season_offset: v ?? 0 })}
                      />
                    </FieldRow>
                    <FieldRow label="集数偏移">
                      <InputNumber
                        value={local.episode_offset}
                        style={{ width: 90 }}
                        onChange={(v) => patch({ episode_offset: v ?? 0 })}
                      />
                    </FieldRow>
                    {offsetReason && (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12, textAlign: 'right' }}
                      >
                        {offsetReason}
                      </Typography.Text>
                    )}
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
                        value={local.episode_type}
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
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      设置后，RSS 刷新时若存在偏好版本，会跳过不匹配的重复发布。
                    </Typography.Text>
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      {/* 删除/禁用确认（嵌套弹窗，可勾选连带删除已下载文件） */}
      <Modal
        open={deleteDialog.show}
        title={deleteDialog.type === 'delete' ? '删除' : '禁用'}
        width={400}
        onCancel={() => setDeleteDialog((d) => ({ ...d, show: false }))}
        footer={
          <>
            <Button
              size="small"
              onClick={() => setDeleteDialog((d) => ({ ...d, show: false }))}
            >
              取消
            </Button>
            <Button
              size="small"
              danger
              loading={busy}
              onClick={() => void handleDeleteConfirm()}
            >
              {deleteDialog.type === 'delete' ? '删除' : '禁用'}
            </Button>
          </>
        }
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 14 }}>
          {deleteDialog.type === 'delete'
            ? '将删除该订阅规则，此操作无法撤销。'
            : '将禁用该订阅规则，暂停对其的 RSS 更新。'}
        </Typography.Paragraph>
        <Checkbox
          checked={deleteFiles}
          onChange={(e) => setDeleteFiles(e.target.checked)}
        >
          同时删除已下载的文件
        </Checkbox>
      </Modal>
    </Modal>
  );
}
