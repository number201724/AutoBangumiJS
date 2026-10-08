/**
 * 放送日历 — React + AntD 移植自 Vue 版 pages/index/calendar.vue +
 * components/calendar/*。按 air_weekday（0=周一…6=周日）分列，无放送日的
 * 归入「未知」组；卡片上可直接下拉调整放送日（替代桌面端拖拽）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Grid, Select, Tag, Typography, message } from 'antd';
import { FileImageOutlined, PushpinFilled, ReloadOutlined } from '@ant-design/icons';
import type { Bangumi } from '@ab/types';

import { apiBangumi } from '@/api/bangumi';
import { selectActive, useBangumiStore } from '@/stores/bangumi';
import { EditRuleModal } from '@/components/bangumi/edit-rule-modal';
import { RuleListModal } from '@/components/bangumi/rule-list-modal';
import {
  WEEKDAY_FULL,
  WEEKDAY_SHORT,
  groupBangumi,
  resolvePosterUrl,
  todayWeekdayIndex,
  type BangumiGroup,
} from '@/components/bangumi/utils';
import '@/components/bangumi/bangumi.css';

const UNKNOWN = 'unknown';
const DAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'] as const;

const WEEKDAY_OPTIONS = WEEKDAY_FULL.map((label, value) => ({ label, value }));

export function CalendarPage() {
  const bangumi = useBangumiStore((s) => s.bangumi);
  const { getAll, setWeekday } = useBangumiStore();
  const [refreshing, setRefreshing] = useState(false);
  const [editRule, setEditRule] = useState<Bangumi | null>(null);
  const [ruleListGroup, setRuleListGroup] = useState<BangumiGroup | null>(null);

  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  useEffect(() => {
    // 进入页面只重读本地数据；bangumi.tv 抓取留给显式刷新按钮
    void getAll();
  }, [getAll]);

  async function refreshCalendar() {
    setRefreshing(true);
    try {
      await apiBangumi.refreshCalendar();
      await getAll();
      void message.success('日历已刷新');
    } catch {
      /* 拦截器已提示 */
    } finally {
      setRefreshing(false);
    }
  }

  const todayIndex = todayWeekdayIndex();
  const active = useMemo(() => selectActive(bangumi), [bangumi]);

  // 先按天分，再按 official_title+season 分组（与 Vue 版一致）
  const groupedByDay = useMemo(() => {
    const itemsByDay: Record<string, Bangumi[]> = {};
    for (const key of [...DAY_KEYS, UNKNOWN]) itemsByDay[key] = [];
    for (const item of active) {
      const w = item.air_weekday;
      if (w != null && w >= 0 && w <= 6) itemsByDay[String(w)].push(item);
      else itemsByDay[UNKNOWN].push(item);
    }
    const result: Record<string, BangumiGroup[]> = {};
    for (const key of [...DAY_KEYS, UNKNOWN]) {
      result[key] = groupBangumi(itemsByDay[key]);
    }
    return result;
  }, [active]);

  const hasBangumi = active.length > 0;

  function dayLabel(key: string): string {
    if (key === UNKNOWN) return '未知';
    const idx = Number(key);
    return isMobile ? WEEKDAY_FULL[idx] : `周${WEEKDAY_SHORT[idx]}`;
  }

  function onCardClick(group: BangumiGroup) {
    if (group.rules.length === 1) {
      setEditRule(group.primary);
    } else {
      setRuleListGroup(group);
    }
  }

  /** 设置整组的放送日（对应 Vue 拖拽落列时对组内每条规则 setWeekday） */
  async function assignWeekday(group: BangumiGroup, weekday: number | null) {
    for (const rule of group.rules) {
      await setWeekday(rule.id, weekday);
    }
  }

  function renderCard(group: BangumiGroup, inKnownDay: boolean) {
    const primary = group.primary;
    const locked = primary.weekday_locked;
    return (
      <div key={group.key} className="cal-card-wrap">
        <div
          className={`cal-card${inKnownDay && locked ? ' cal-card--pinned' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`编辑 ${primary.official_title}`}
          onClick={() => onCardClick(group)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCardClick(group);
          }}
        >
          <div className="cal-card-poster">
            {primary.poster_link ? (
              <img
                src={resolvePosterUrl(primary.poster_link)}
                alt={primary.official_title}
                loading="lazy"
              />
            ) : (
              <div className="cal-card-placeholder">
                <FileImageOutlined style={{ fontSize: 20 }} />
                <span className="cal-card-placeholder-title">{primary.official_title}</span>
              </div>
            )}
            <div className="cal-card-overlay">
              <div className="cal-card-overlay-title">{primary.official_title}</div>
              <div className="cal-card-overlay-tags">
                <span className="bgm-overlay-tag">{`S${primary.season}`}</span>
                {primary.group_name && (
                  <span className="bgm-overlay-tag">{primary.group_name}</span>
                )}
              </div>
            </div>
            {inKnownDay && locked && (
              <div className="cal-card-pin" title="手动设置">
                <PushpinFilled />
              </div>
            )}
          </div>
        </div>
        {/* 解除手动锁定（重置为未知） */}
        {inKnownDay && locked && (
          <button
            type="button"
            className="cal-unpin-btn"
            title="重置为未知"
            onClick={(e) => {
              e.stopPropagation();
              void assignWeekday(group, null);
            }}
          >
            ×
          </button>
        )}
        {group.rules.length > 1 && (
          <div className="bgm-group-badge">{group.rules.length}</div>
        )}
        {/* 手动设置放送日 */}
        <div onClick={(e) => e.stopPropagation()}>
          <Select
            size="small"
            variant="filled"
            value={primary.air_weekday ?? undefined}
            options={WEEKDAY_OPTIONS}
            allowClear
            placeholder="未知"
            aria-label="放送星期"
            style={{ width: '100%', marginTop: 4 }}
            onChange={(v?: number) => void assignWeekday(group, v ?? null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography.Text type="secondary">本季度放送时间表</Typography.Text>
        <Button
          icon={<ReloadOutlined spin={refreshing} />}
          loading={refreshing}
          onClick={() => void refreshCalendar()}
        >
          刷新放送表
        </Button>
      </div>

      {!hasBangumi ? (
        <Empty
          style={{ padding: '48px 0' }}
          description={
            <>
              <Typography.Title level={5}>暂无放送表</Typography.Title>
              <Typography.Text type="secondary">
                点击刷新按钮获取本季度放送数据
              </Typography.Text>
            </>
          }
        />
      ) : !isMobile ? (
        /* 桌面：7 列看板 */
        <>
          <div className="cal-grid">
            {DAY_KEYS.map((key, index) => (
              <div
                key={key}
                className={`cal-column${index === todayIndex ? ' cal-column--today' : ''}`}
              >
                <div className="cal-day-header">
                  <span>{dayLabel(key)}</span>
                  {index === todayIndex && <Tag color="blue">今天</Tag>}
                </div>
                {groupedByDay[key].map((g) => renderCard(g, true))}
                {groupedByDay[key].length === 0 && (
                  <div className="cal-empty-day">今日无番</div>
                )}
              </div>
            ))}
          </div>

          {/* 未知放送日分区 */}
          {groupedByDay[UNKNOWN].length > 0 && (
            <div className="cal-unknown-section">
              <div className="cal-day-header" style={{ marginBottom: 10 }}>
                <span>未知</span>
                <Typography.Text type="secondary" style={{ fontSize: 11 }} italic>
                  通过卡片下方下拉设置放送日
                </Typography.Text>
              </div>
              <div className="cal-unknown-items">
                {groupedByDay[UNKNOWN].map((g) => renderCard(g, false))}
              </div>
            </div>
          )}
        </>
      ) : (
        /* 移动端：纵向分区列表 */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[...DAY_KEYS, UNKNOWN].map((key, index) => {
            const groups = groupedByDay[key];
            if (groups.length === 0 && key === UNKNOWN) return null;
            return (
              <div key={key}>
                <div className="cal-day-header">
                  <span>{dayLabel(key)}</span>
                  {key !== UNKNOWN && index === todayIndex && <Tag color="blue">今天</Tag>}
                </div>
                {groups.length === 0 ? (
                  <div className="cal-empty-day">今日无番</div>
                ) : (
                  <div className="cal-mobile-items">
                    {groups.map((g) => renderCard(g, key !== UNKNOWN))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 弹窗 */}
      <EditRuleModal
        rule={editRule}
        open={editRule !== null}
        onClose={() => setEditRule(null)}
      />
      <RuleListModal
        open={ruleListGroup !== null}
        group={ruleListGroup}
        onSelect={(rule) => {
          setRuleListGroup(null);
          setEditRule(rule);
        }}
        onClose={() => setRuleListGroup(null)}
      />
    </div>
  );
}
