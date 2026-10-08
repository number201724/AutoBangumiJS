/**
 * 番剧海报卡片 — 移植自 Vue 版 ab-bangumi-card.vue（type="primary"）+
 * bangumi.vue 的组角标/归档角标。
 */
import type { CSSProperties, ReactNode } from 'react';
import { EditOutlined, FileImageOutlined } from '@ant-design/icons';
import type { Bangumi } from '@ab/types';

import { resolvePosterUrl } from './utils';

interface BangumiCardProps {
  bangumi: Bangumi;
  /** 右上角组角标内容（多规则计数或 "!" 警告） */
  badge?: ReactNode;
  /** needs-review：角标变警告色 + 海报描边 */
  warning?: boolean;
  archived?: boolean;
  /** 组内全部规则 deleted 时整卡灰显 */
  grayscale?: boolean;
  style?: CSSProperties;
  onClick: () => void;
}

export function BangumiCard({
  bangumi,
  badge,
  warning = false,
  archived = false,
  grayscale = false,
  style,
  onClick,
}: BangumiCardProps) {
  return (
    <div
      className={`bgm-card-wrap${grayscale ? ' bgm-grayscale' : ''}`}
      style={style}
    >
      <div
        className="bgm-card"
        role="button"
        tabIndex={0}
        aria-label={`编辑 ${bangumi.official_title}`}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <div className={`bgm-poster${warning ? ' bgm-poster--review' : ''}`}>
          {bangumi.poster_link ? (
            <img
              src={resolvePosterUrl(bangumi.poster_link)}
              alt={bangumi.official_title}
              loading="lazy"
            />
          ) : (
            <div className="bgm-poster-placeholder">
              <FileImageOutlined />
            </div>
          )}
          <div className="bgm-overlay">
            <div className="bgm-overlay-edit">
              <EditOutlined />
            </div>
            <div className="bgm-overlay-tags">
              <span className="bgm-overlay-tag">{`Season ${bangumi.season}`}</span>
              {bangumi.group_name && (
                <span className="bgm-overlay-tag">{bangumi.group_name}</span>
              )}
            </div>
          </div>
        </div>
        <div className="bgm-title" title={bangumi.official_title}>
          {bangumi.official_title}
        </div>
      </div>
      {badge && (
        <div className={`bgm-group-badge${warning ? ' bgm-group-badge--warning' : ''}`}>
          {badge}
        </div>
      )}
      {archived && <div className="bgm-archived-badge">已归档</div>}
    </div>
  );
}

/** 组角标内容：needs-review 优先显示 "!"，多规则追加计数 */
export function GroupBadgeContent({
  warning,
  count,
}: {
  warning: boolean;
  count: number;
}) {
  if (warning) {
    return (
      <>
        <span>!</span>
        {count > 1 && <span>{count}</span>}
      </>
    );
  }
  return <>{count}</>;
}
