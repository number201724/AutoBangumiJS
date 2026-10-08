/**
 * 番剧主页 — React + AntD 移植自 Vue 版 pages/index/bangumi.vue。
 * 卡片网格（official_title+season 分组、needs-review 角标、归档分区）、
 * 搜索过滤、新建/编辑规则、needs-review 顶部 Alert + 处理对话框、
 * 未匹配种子入口，以及全局动作（刷新全部海报/放送表/元数据、重置全部）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
  Typography,
  message,
} from 'antd';
import {
  DownOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { Bangumi } from '@ab/types';

import { apiBangumi } from '@/api/bangumi';
import { selectActive, selectArchived, useBangumiStore } from '@/stores/bangumi';
import { AddBangumiModal } from '@/components/bangumi/add-bangumi-modal';
import { BangumiCard, GroupBadgeContent } from '@/components/bangumi/bangumi-card';
import { EditRuleModal } from '@/components/bangumi/edit-rule-modal';
import { ReviewDialog } from '@/components/bangumi/review-dialog';
import { RuleListModal } from '@/components/bangumi/rule-list-modal';
import {
  groupBangumi,
  groupNeedsReview,
  msgOf,
  type BangumiGroup,
} from '@/components/bangumi/utils';
import '@/components/bangumi/bangumi.css';

const SKELETON_COUNT = 8;

export function BangumiPage() {
  const navigate = useNavigate();
  const { bangumi, showArchived, isLoading, hasLoaded, loadFailed } = useBangumiStore();
  const { getAll, setShowArchived } = useBangumiStore();

  const [refreshing, setRefreshing] = useState(false);
  const [keyword, setKeyword] = useState('');

  // 未匹配种子数（Others 卡片）
  const [orphanCount, setOrphanCount] = useState(0);
  // needs-review 列表
  const [reviewItems, setReviewItems] = useState<Bangumi[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);

  // 弹窗状态
  const [addOpen, setAddOpen] = useState(false);
  const [editRule, setEditRule] = useState<Bangumi | null>(null);
  const [ruleListGroup, setRuleListGroup] = useState<BangumiGroup | null>(null);

  const loadOrphanCount = useCallback(async () => {
    try {
      setOrphanCount(await apiBangumi.getOrphanCount());
    } catch {
      setOrphanCount(0);
    }
  }, []);

  const loadNeedsReview = useCallback(async () => {
    try {
      setReviewItems(await apiBangumi.needsReview());
    } catch {
      setReviewItems([]);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([getAll(), loadOrphanCount(), loadNeedsReview()]);
  }, [getAll, loadOrphanCount, loadNeedsReview]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
    }
  }

  /** 全局动作：toast 后端 msg_zh 并刷新列表 */
  async function runGlobal(fn: () => Promise<unknown>, fallback: string) {
    setRefreshing(true);
    try {
      const res = await fn();
      void message.success(msgOf(res, fallback));
      await getAll();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setRefreshing(false);
    }
  }

  function onResetAll() {
    Modal.confirm({
      title: '重置规则',
      content: '将重置所有订阅规则（清空后需重新订阅），此操作无法撤销。确定继续吗？',
      okText: '重置全部',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => runGlobal(() => apiBangumi.resetAll(), '重置所有规则成功。'),
    });
  }

  // 分组 + 搜索过滤
  const matches = useCallback(
    (b: Bangumi) => {
      const kw = keyword.trim().toLowerCase();
      if (!kw) return true;
      return [b.official_title, b.title_raw, b.group_name, b.rule_name].some((f) =>
        f?.toLowerCase().includes(kw),
      );
    },
    [keyword],
  );

  const groupedActive = useMemo(
    () => groupBangumi(selectActive(bangumi).filter((b) => matches(b))),
    [bangumi, matches],
  );
  const groupedArchived = useMemo(
    () => groupBangumi(selectArchived(bangumi).filter((b) => matches(b))),
    [bangumi, matches],
  );

  // 卡片点击：单规则直接编辑，多规则先选规则
  function onCardClick(group: BangumiGroup) {
    if (group.rules.length === 1) {
      setEditRule(group.primary);
    } else {
      setRuleListGroup(group);
    }
  }

  function onRuleSelect(rule: Bangumi) {
    setRuleListGroup(null);
    setEditRule(rule);
  }

  const showSkeleton = !hasLoaded && isLoading;

  /** 网格中的一组卡片（含角标） */
  function renderGroup(group: BangumiGroup, archived: boolean) {
    const warning = groupNeedsReview(group);
    const count = group.rules.length;
    return (
      <BangumiCard
        key={group.key}
        bangumi={group.primary}
        warning={warning}
        archived={archived}
        grayscale={group.rules.every((r) => r.deleted)}
        badge={
          warning || count > 1 ? (
            <GroupBadgeContent warning={warning} count={count} />
          ) : undefined
        }
        onClick={() => onCardClick(group)}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 工具栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: 'rgba(0,0,0,0.25)' }} />}
          placeholder="输入关键字搜索"
          style={{ width: 220 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <span style={{ flex: 1 }} />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setAddOpen(true)}
        >
          添加
        </Button>
        <Button
          icon={<ReloadOutlined spin={refreshing} />}
          loading={refreshing}
          onClick={() => void onRefresh()}
        >
          刷新
        </Button>
        <Dropdown
          menu={{
            items: [
              { key: 'poster', label: '刷新海报' },
              { key: 'calendar', label: '刷新放送表' },
              { key: 'metadata', label: '刷新元数据' },
              { type: 'divider' },
              { key: 'reset', label: '重置规则', danger: true },
            ],
            onClick: ({ key }) => {
              if (key === 'poster') {
                void runGlobal(() => apiBangumi.refreshPosterAll(), '海报已刷新。');
              } else if (key === 'calendar') {
                void runGlobal(() => apiBangumi.refreshCalendar(), '日历已刷新');
              } else if (key === 'metadata') {
                void runGlobal(() => apiBangumi.refreshMetadata(), '元数据已刷新。');
              } else if (key === 'reset') {
                onResetAll();
              }
            },
          }}
        >
          <Button>
            更多操作 <DownOutlined />
          </Button>
        </Dropdown>
      </div>

      {/* needs-review 顶部提示 */}
      {reviewItems.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`有 ${reviewItems.length} 部番剧需要检查偏移量`}
          description="RSS 解析结果与 TMDB 数据不一致，建议检查并应用推荐的季度/集数偏移。"
          action={
            <Button size="small" type="primary" onClick={() => setReviewOpen(true)}>
              查看
            </Button>
          }
        />
      )}

      {/* 骨架屏（首次加载） */}
      {showSkeleton && (
        <div className="bgm-grid">
          {Array.from({ length: SKELETON_COUNT }, (_, i) => (
            <div key={`skeleton-${i}`}>
              <div className="bgm-skeleton-poster" />
              <div className="bgm-skeleton-title" />
            </div>
          ))}
        </div>
      )}

      {/* 首次加载失败（区别于空库） */}
      {!showSkeleton && loadFailed && !hasLoaded && (
        <Empty
          style={{ padding: '48px 0' }}
          description={
            <>
              <Typography.Title level={5}>订阅列表加载失败</Typography.Title>
              <Typography.Text type="secondary">
                后端没有响应。请确认 AutoBangumi 正在运行，然后重试。
              </Typography.Text>
            </>
          }
        >
          <Button type="primary" loading={isLoading} onClick={() => void getAll()}>
            重试
          </Button>
        </Empty>
      )}

      {/* 空状态引导 */}
      {!showSkeleton && !(loadFailed && !hasLoaded) && bangumi.length === 0 && (
        <Empty
          style={{ padding: '48px 0' }}
          description={
            <>
              <Typography.Title level={5}>暂无订阅</Typography.Title>
              <Typography.Text type="secondary">
                添加你的第一个 RSS 订阅开始使用
              </Typography.Text>
            </>
          }
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              maxWidth: 400,
              margin: '0 auto 24px',
              textAlign: 'left',
            }}
          >
            {[
              ['添加 RSS 订阅', '点击上方「添加」按钮，粘贴来自番剧源的 RSS 链接。'],
              ['配置下载器', '前往设置页面，配置你的下载器（如 qBittorrent）连接信息。'],
              ['坐享其成', 'AutoBangumi 将自动下载并重命名新剧集。'],
            ].map(([title, desc], i) => (
              <div
                key={title}
                style={{
                  display: 'flex',
                  gap: 14,
                  padding: '12px 16px',
                  borderRadius: 8,
                  border: '1px solid rgba(0,0,0,0.08)',
                  alignItems: 'flex-start',
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: '#1890ff',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {i + 1}
                </span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    {desc}
                  </Typography.Text>
                </div>
              </div>
            ))}
          </div>
          <Button type="primary" onClick={() => setAddOpen(true)}>
            添加 RSS 订阅
          </Button>
        </Empty>
      )}

      {/* 番剧网格 */}
      {!showSkeleton && groupedActive.length > 0 && (
        <div className="bgm-grid">
          {groupedActive.map((g) => renderGroup(g, false))}

          {/* 未匹配种子入口 */}
          {orphanCount > 0 && (
            <div className="bgm-card-wrap">
              <div
                className="bgm-card"
                role="button"
                tabIndex={0}
                aria-label="未匹配种子"
                onClick={() => void navigate('/bangumi-torrents/orphans')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void navigate('/bangumi-torrents/orphans');
                }}
              >
                <div className="bgm-others-poster">
                  <span className="bgm-others-icon">?</span>
                  <span className="bgm-others-count bgm-group-badge">{orphanCount}</span>
                </div>
                <div className="bgm-title">未匹配种子</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 归档分区 */}
      {groupedArchived.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Button
            type="text"
            style={{ padding: '4px 8px' }}
            onClick={() => setShowArchived(!showArchived)}
            aria-expanded={showArchived}
          >
            <Typography.Text type="secondary">
              {`已归档 (${selectArchived(bangumi).length})`}
            </Typography.Text>
            <span style={{ marginLeft: 8 }}>{showArchived ? '−' : '+'}</span>
          </Button>
          {showArchived && (
            <div className="bgm-grid bgm-archived-grid">
              {groupedArchived.map((g) => renderGroup(g, true))}
            </div>
          )}
        </div>
      )}

      {/* 弹窗 */}
      <AddBangumiModal open={addOpen} onClose={() => setAddOpen(false)} />
      <EditRuleModal
        rule={editRule}
        open={editRule !== null}
        onClose={() => {
          setEditRule(null);
          // 弹窗内可能已应用/忽略 needs-review，关闭时同步顶部 Alert
          void loadNeedsReview();
        }}
      />
      <RuleListModal
        open={ruleListGroup !== null}
        group={ruleListGroup}
        onSelect={onRuleSelect}
        onClose={() => setRuleListGroup(null)}
      />
      <ReviewDialog
        open={reviewOpen}
        items={reviewItems}
        onClose={() => setReviewOpen(false)}
        onChanged={() => void refreshAll()}
      />
    </div>
  );
}
