/**
 * 季度/集数偏移确认对话框 — 移植自 Vue 版 basic/ab-offset-mismatch-dialog.vue。
 * 展示 RSS 解析结果与 TMDB 数据的差异，允许手动调整建议偏移量后应用。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Col, InputNumber, Modal, Row, Tag, Typography } from 'antd';
import { WarningFilled } from '@ant-design/icons';

export interface OffsetSuggestion {
  season_offset: number;
  episode_offset: number;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface TmdbInfo {
  title: string;
  total_seasons: number;
  season_episode_counts: Record<string, number>;
  status: string | null;
  virtual_season_starts: Record<string, number[]> | null;
}

interface OffsetMismatchDialogProps {
  open: boolean;
  bangumiTitle: string;
  parsedSeason: number;
  parsedEpisode: number;
  tmdbInfo: TmdbInfo | null;
  suggestion: OffsetSuggestion | null;
  onApply: (offsets: { seasonOffset: number; episodeOffset: number }) => void;
  onKeep: () => void;
  onCancel: () => void;
}

const CONFIDENCE_COLOR: Record<string, string> = {
  high: 'red',
  medium: 'orange',
  low: 'default',
};

export function OffsetMismatchDialog({
  open,
  bangumiTitle,
  parsedSeason,
  parsedEpisode,
  tmdbInfo,
  suggestion,
  onApply,
  onKeep,
  onCancel,
}: OffsetMismatchDialogProps) {
  const [seasonOffset, setSeasonOffset] = useState(suggestion?.season_offset ?? 0);
  const [episodeOffset, setEpisodeOffset] = useState(suggestion?.episode_offset ?? 0);

  useEffect(() => {
    if (suggestion) {
      setSeasonOffset(suggestion.season_offset);
      setEpisodeOffset(suggestion.episode_offset);
    }
  }, [suggestion]);

  const preview = useMemo(() => {
    const fmt = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return {
      from: `S${fmt(parsedSeason)}E${fmt(parsedEpisode)}`,
      to: `S${fmt(Math.max(1, parsedSeason + seasonOffset))}E${fmt(
        Math.max(1, parsedEpisode + episodeOffset),
      )}`,
    };
  }, [parsedSeason, parsedEpisode, seasonOffset, episodeOffset]);

  const targetSeason = parsedSeason + (suggestion?.season_offset ?? 0);
  const targetEpisodes = tmdbInfo?.season_episode_counts?.[String(targetSeason)];

  return (
    <Modal
      open={open}
      width={480}
      onCancel={onCancel}
      title={
        <span>
          <WarningFilled style={{ color: '#faad14', marginRight: 8 }} />
          检测到季度/集数不匹配
        </span>
      }
      footer={
        <>
          <Button size="small" onClick={onCancel}>
            取消
          </Button>
          <Button size="small" type="primary" ghost onClick={onKeep}>
            保持原样
          </Button>
          <Button
            size="small"
            type="primary"
            onClick={() => onApply({ seasonOffset, episodeOffset })}
          >
            应用建议
          </Button>
        </>
      }
    >
      <Typography.Title
        level={5}
        style={{ textAlign: 'center', color: '#1890ff', marginTop: 4 }}
      >
        {bangumiTitle}
      </Typography.Title>

      {/* 解析结果 vs TMDB */}
      <Row gutter={12} align="middle" style={{ marginBottom: 16 }}>
        <Col flex={1}>
          <div
            style={{
              padding: 12,
              background: 'rgba(0,0,0,0.03)',
              borderRadius: 8,
              border: '1px solid rgba(0,0,0,0.06)',
            }}
          >
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase' }}
            >
              RSS 解析结果
            </Typography.Text>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <Typography.Text type="secondary">季度：</Typography.Text>
              <Typography.Text strong>{parsedSeason}</Typography.Text>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Typography.Text type="secondary">集数：</Typography.Text>
              <Typography.Text strong>{parsedEpisode}</Typography.Text>
            </div>
          </div>
        </Col>
        <Col flex="32px" style={{ textAlign: 'center', fontSize: 20, color: '#faad14' }}>
          ≠
        </Col>
        <Col flex={1}>
          <div
            style={{
              padding: 12,
              background: 'rgba(0,0,0,0.03)',
              borderRadius: 8,
              border: '1px solid rgba(0,0,0,0.06)',
            }}
          >
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase' }}
            >
              TMDB 数据
            </Typography.Text>
            {tmdbInfo && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                <Typography.Text type="secondary">总季数：</Typography.Text>
                <Typography.Text strong>{tmdbInfo.total_seasons}</Typography.Text>
              </div>
            )}
            {targetEpisodes != null && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography.Text type="secondary">S{targetSeason} 集数：</Typography.Text>
                <Typography.Text strong>{targetEpisodes}</Typography.Text>
              </div>
            )}
          </div>
        </Col>
      </Row>

      {/* 原因 */}
      {suggestion?.reason && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            padding: 12,
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <Tag color={CONFIDENCE_COLOR[suggestion.confidence] ?? 'default'}>
            {suggestion.confidence}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {suggestion.reason}
          </Typography.Text>
        </div>
      )}

      {/* 偏移输入 */}
      <div
        style={{
          padding: 16,
          background: 'rgba(0,0,0,0.03)',
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <Typography.Text strong style={{ fontSize: 13 }}>
          建议偏移量
        </Typography.Text>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}
        >
          <span style={{ width: 100, fontSize: 13 }}>季度偏移：</span>
          <InputNumber value={seasonOffset} onChange={(v) => setSeasonOffset(v ?? 0)} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            → S{parsedSeason} 变为 S{Math.max(1, parsedSeason + seasonOffset)}
          </Typography.Text>
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}
        >
          <span style={{ width: 100, fontSize: 13 }}>集数偏移：</span>
          <InputNumber value={episodeOffset} onChange={(v) => setEpisodeOffset(v ?? 0)} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            → E{parsedEpisode} 保持 E{Math.max(1, parsedEpisode + episodeOffset)}
          </Typography.Text>
        </div>
      </div>

      {/* 预览 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 12,
          background: 'rgba(24, 144, 255, 0.08)',
          borderRadius: 8,
        }}
      >
        <Typography.Text type="secondary">预览：</Typography.Text>
        <Typography.Text delete strong style={{ fontSize: 16 }}>
          {preview.from}
        </Typography.Text>
        <Typography.Text style={{ color: '#1890ff', fontSize: 18 }}>→</Typography.Text>
        <Typography.Text strong style={{ color: '#1890ff', fontSize: 16 }}>
          {preview.to}
        </Typography.Text>
      </div>
    </Modal>
  );
}
