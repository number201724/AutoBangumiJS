/**
 * 全局搜索弹窗 — 移植自 Vue 版 ab-search-modal.vue：
 * 顶部搜索框（回车触发）+ 站点 Select + 清空/关闭按钮；
 * 结果区按 official_title 分组（海报/标题/年份/变体数），变体默认每组最多 12 个可展开；
 * 组/分辨率/字幕/季度 4 类多选筛选芯片云（每类默认最多 6 个可展开，选中后互相约束，
 * 不可能产生结果的芯片置灰），已选筛选显示区 + 一键清除；筛选仅在有结果时启用；
 * 加载骨架屏、失败 Alert、空态 Empty。ESC/遮罩点击关闭由 AntD Modal 提供。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Skeleton,
  Spin,
  type InputRef,
} from 'antd';
import {
  CalendarOutlined,
  CloseOutlined,
  MonitorOutlined,
  SearchOutlined,
  TeamOutlined,
  TranslationOutlined,
} from '@ant-design/icons';

import {
  getResolution,
  getSeason,
  getSubtitle,
  groupResults,
  useSearchStore,
  type GroupedBangumi,
  type SearchVariant,
} from '@/stores/search';
import { resolvePosterUrl } from '@/components/bangumi/utils';

import { SearchVariantCard } from './search-card';
import { SearchConfirm } from './search-confirm';
import './search.css';

type FilterCategory = 'group' | 'resolution' | 'subtitle' | 'season';
type ActiveFilters = Record<FilterCategory, string[]>;

const EMPTY_FILTERS: ActiveFilters = {
  group: [],
  resolution: [],
  subtitle: [],
  season: [],
};

/** 每类筛选默认展示的芯片数（超出可展开） */
const MAX_VISIBLE_CHIPS = 6;

/** 每部番剧默认展示的变体数（约 4 行 × 3 个，超出可展开） */
const MAX_VISIBLE_VARIANTS = 12;

const FILTER_CATEGORIES: { key: FilterCategory; label: string; icon: ReactNode }[] = [
  { key: 'group', label: '字幕组', icon: <TeamOutlined /> },
  { key: 'resolution', label: '分辨率', icon: <MonitorOutlined /> },
  { key: 'subtitle', label: '字幕语言', icon: <TranslationOutlined /> },
  { key: 'season', label: '季度', icon: <CalendarOutlined /> },
];

export function SearchModal() {
  const keyword = useSearchStore((s) => s.keyword);
  const provider = useSearchStore((s) => s.provider);
  const providers = useSearchStore((s) => s.providers);
  const loading = useSearchStore((s) => s.loading);
  const searchFailed = useSearchStore((s) => s.searchFailed);
  const data = useSearchStore((s) => s.data);
  const showModal = useSearchStore((s) => s.showModal);

  const getProviders = useSearchStore((s) => s.getProviders);
  const setKeyword = useSearchStore((s) => s.setKeyword);
  const setProvider = useSearchStore((s) => s.setProvider);
  const onSearch = useSearchStore((s) => s.onSearch);
  const clearSearch = useSearchStore((s) => s.clearSearch);
  const closeSearch = useSearchStore((s) => s.closeSearch);
  const closeModal = useSearchStore((s) => s.closeModal);
  const selectResult = useSearchStore((s) => s.selectResult);

  const inputRef = useRef<InputRef>(null);

  // 多选筛选状态（仅在有结果时启用，见 showFilters）
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>(EMPTY_FILTERS);
  // 已展开芯片云的筛选类别
  const [expandedCategories, setExpandedCategories] = useState<Set<FilterCategory>>(new Set());
  // 已展开全部变体的番剧组 key
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(new Set());

  // 组件卸载时关闭 EventSource（防搜索中途导航离开导致流泄漏）
  useEffect(() => closeSearch, [closeSearch]);

  // 挂载时拉取站点列表
  useEffect(() => {
    void getProviders();
  }, [getProviders]);

  // 打开弹窗后聚焦搜索框
  useEffect(() => {
    if (!showModal) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [showModal]);

  // 搜索词变化时清空筛选与展开状态（对应 Vue watch(inputValue)）
  useEffect(() => {
    setActiveFilters(EMPTY_FILTERS);
    setExpandedCategories(new Set());
    setExpandedVariants(new Set());
  }, [keyword]);

  // 按 official_title 分组（对应 Vue store 的 groupedResults computed）
  const groupedResults = useMemo(() => groupResults(data), [data]);

  // ---------------------------------------------------------------------------
  // 筛选选项与筛选逻辑（移植自 Vue ab-search-modal.vue）
  // ---------------------------------------------------------------------------

  // 从分组结果提取全部筛选选项（含定制排序）
  const filterOptions = useMemo(() => {
    const groups = new Set<string>();
    const resolutions = new Set<string>();
    const subtitles = new Set<string>();
    const seasons = new Set<string>();

    for (const group of groupedResults) {
      for (const variant of group.variants) {
        if (variant.group_name) groups.add(variant.group_name);
        const res = getResolution(variant);
        if (res) resolutions.add(res);
        const sub = getSubtitle(variant);
        if (sub) subtitles.add(sub);
        const season = getSeason(variant);
        if (season) seasons.add(season);
      }
    }

    /** 已知值按给定顺序排，未知值按字典序排最后 */
    const sortByOrder = (order: string[]) => (a: string, b: string) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    };

    return {
      group: Array.from(groups).sort(),
      resolution: Array.from(resolutions).sort(sortByOrder(['4K', 'FHD', 'HD', 'SD'])),
      subtitle: Array.from(subtitles).sort(
        sortByOrder(['简', '繁', '双语', '简/内嵌', '繁/内嵌', '内嵌', '外挂', '日']),
      ),
      season: Array.from(seasons).sort((a, b) => {
        // S1, S2, S3… 在前，剧场版/OVA/SP 等特殊类型在后
        const am = a.match(/^S(\d+)$/);
        const bm = b.match(/^S(\d+)$/);
        if (am && bm) return parseInt(am[1], 10) - parseInt(bm[1], 10);
        if (am) return -1;
        if (bm) return 1;
        return a.localeCompare(b);
      }),
    };
  }, [groupedResults]);

  // 仅在有结果且有可筛选项时启用筛选
  const showFilters =
    groupedResults.length > 0 &&
    (filterOptions.group.length > 0 ||
      filterOptions.resolution.length > 0 ||
      filterOptions.subtitle.length > 0 ||
      filterOptions.season.length > 0);

  const hasActiveFilters = Object.values(activeFilters).some((arr) => arr.length > 0);

  function toggleFilter(type: FilterCategory, value: string) {
    setActiveFilters((prev) => {
      const arr = prev[type];
      const next = arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
      return { ...prev, [type]: next };
    });
  }

  /** 变体是否命中当前多选筛选（各类别内部是 OR，类别之间是 AND） */
  function variantMatchesFilters(variant: SearchVariant): boolean {
    const { group, resolution, subtitle, season } = activeFilters;
    if (group.length > 0 && (!variant.group_name || !group.includes(variant.group_name))) {
      return false;
    }
    if (resolution.length > 0) {
      const res = getResolution(variant);
      if (!res || !resolution.includes(res)) return false;
    }
    if (subtitle.length > 0) {
      const sub = getSubtitle(variant);
      if (!sub || !subtitle.includes(sub)) return false;
    }
    if (season.length > 0) {
      const s = getSeason(variant);
      if (!s || !season.includes(s)) return false;
    }
    return true;
  }

  function getFilteredVariants(group: GroupedBangumi): SearchVariant[] {
    if (!hasActiveFilters) return group.variants;
    return group.variants.filter(variantMatchesFilters);
  }

  // 已选筛选标签（展示用）
  const selectedFilterTags = useMemo(() => {
    const tags: { type: FilterCategory; value: string }[] = [];
    for (const cat of FILTER_CATEGORIES) {
      for (const value of activeFilters[cat.key]) {
        tags.push({ type: cat.key, value });
      }
    }
    return tags;
  }, [activeFilters]);

  function clearFilters() {
    setActiveFilters(EMPTY_FILTERS);
  }

  const totalVariantCount = useMemo(
    () => groupedResults.reduce((sum, g) => sum + g.variants.length, 0),
    [groupedResults],
  );

  // 结果集不大，直接每次渲染重算（getFilteredVariants 依赖 activeFilters 闭包）
  const filteredVariantCount = hasActiveFilters
    ? groupedResults.reduce((sum, g) => sum + getFilteredVariants(g).length, 0)
    : totalVariantCount;

  const allVariants = useMemo(
    () => groupedResults.flatMap((g) => g.variants),
    [groupedResults],
  );

  /**
   * 假设勾选某值后是否还会有结果（只约束其他类别的已选项）——
   * 不可能产生结果的芯片置灰，防止用户筛出空列表
   */
  function wouldProduceResults(type: FilterCategory, value: string): boolean {
    const { group, resolution, subtitle, season } = activeFilters;
    // 已选中的值始终可点（允许取消选择）
    if (activeFilters[type].includes(value)) return true;

    return allVariants.some((variant) => {
      const groupMatch =
        type === 'group'
          ? variant.group_name === value
          : group.length === 0 || (!!variant.group_name && group.includes(variant.group_name));
      if (!groupMatch) return false;

      const res = getResolution(variant);
      const resMatch =
        type === 'resolution'
          ? res === value
          : resolution.length === 0 || (!!res && resolution.includes(res));
      if (!resMatch) return false;

      const sub = getSubtitle(variant);
      const subMatch =
        type === 'subtitle'
          ? sub === value
          : subtitle.length === 0 || (!!sub && subtitle.includes(sub));
      if (!subMatch) return false;

      const s = getSeason(variant);
      const seasonMatch =
        type === 'season'
          ? s === value
          : season.length === 0 || (!!s && season.includes(s));
      return seasonMatch;
    });
  }

  function isFilterDisabled(type: FilterCategory, value: string): boolean {
    // 无已选筛选时不置灰
    if (!hasActiveFilters) return false;
    return !wouldProduceResults(type, value);
  }

  function handleFilterClick(type: FilterCategory, value: string) {
    if (isFilterDisabled(type, value)) return;
    toggleFilter(type, value);
  }

  function getVisibleOptions(category: FilterCategory, options: string[]): string[] {
    if (expandedCategories.has(category)) return options;
    return options.slice(0, MAX_VISIBLE_CHIPS);
  }

  function toggleCategoryExpand(category: FilterCategory) {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  function getVisibleVariants(group: GroupedBangumi): SearchVariant[] {
    const filtered = getFilteredVariants(group);
    if (expandedVariants.has(group.key)) return filtered;
    return filtered.slice(0, MAX_VISIBLE_VARIANTS);
  }

  function toggleVariantsExpand(groupKey: string) {
    setExpandedVariants((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  // ---------------------------------------------------------------------------
  // 头部动作
  // ---------------------------------------------------------------------------

  function handleClear() {
    clearSearch();
    setActiveFilters(EMPTY_FILTERS);
    setExpandedCategories(new Set());
    setExpandedVariants(new Set());
  }

  function handleClose() {
    handleClear();
    closeModal();
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  return (
    <>
      <Modal
        open={showModal}
        onCancel={handleClose}
        footer={null}
        closable={false}
        width={1100}
        style={{ top: 80 }}
        className="search-modal"
      >
        {/* 头部：搜索框 + 站点 Select + 清空/关闭 */}
        <header className="search-header">
          <div className="search-input-wrap">
            {loading ? (
              <Spin size="small" />
            ) : (
              <button
                type="button"
                className="search-icon-btn"
                aria-label="搜索"
                onClick={onSearch}
              >
                <SearchOutlined />
              </button>
            )}
            <Input
              ref={inputRef}
              variant="borderless"
              className="search-input"
              placeholder="输入关键字搜索"
              aria-label="搜索番剧"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onPressEnter={onSearch}
            />
            <Select
              className="search-provider"
              variant="borderless"
              aria-label="选择搜索站点"
              value={provider}
              options={providers.map((p) => ({ value: p, label: p }))}
              popupMatchSelectWidth={false}
              onChange={setProvider}
            />
          </div>
          <Button type="text" size="small" onClick={handleClear}>
            清空
          </Button>
          <Button
            type="text"
            icon={<CloseOutlined />}
            aria-label="关闭"
            onClick={handleClose}
          />
        </header>

        {/* 筛选芯片云（仅在有结果时启用） */}
        {showFilters && (
          <section className="search-filters">
            {FILTER_CATEGORIES.map(
              (cat) =>
                filterOptions[cat.key].length > 0 && (
                  <div key={cat.key} className="search-filter-row">
                    <span className="search-filter-icon" title={cat.label}>
                      {cat.icon}
                    </span>
                    <div className="search-filter-chips">
                      {getVisibleOptions(cat.key, filterOptions[cat.key]).map((option) => {
                        const active = activeFilters[cat.key].includes(option);
                        const disabled = isFilterDisabled(cat.key, option);
                        return (
                          <button
                            key={option}
                            type="button"
                            disabled={disabled}
                            className={[
                              'search-chip',
                              `search-chip--${cat.key}`,
                              active ? 'search-chip--active' : '',
                              disabled ? 'search-chip--disabled' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            onClick={() => handleFilterClick(cat.key, option)}
                          >
                            {option}
                          </button>
                        );
                      })}
                      {filterOptions[cat.key].length > MAX_VISIBLE_CHIPS && (
                        <button
                          type="button"
                          className="search-chip-expand"
                          onClick={() => toggleCategoryExpand(cat.key)}
                        >
                          {expandedCategories.has(cat.key)
                            ? '收起'
                            : `+${filterOptions[cat.key].length - MAX_VISIBLE_CHIPS}`}
                        </button>
                      )}
                    </div>
                  </div>
                ),
            )}

            {/* 已选筛选 + 一键清除 + 计数 */}
            <div className="search-filter-summary">
              {hasActiveFilters ? (
                <div className="search-selected">
                  <span className="search-selected-label">筛选中:</span>
                  <div className="search-selected-chips">
                    {selectedFilterTags.map((tag) => (
                      <button
                        key={`${tag.type}-${tag.value}`}
                        type="button"
                        className={`search-selected-chip search-chip--${tag.type}`}
                        aria-label={`移除筛选 ${tag.value}`}
                        onClick={() => toggleFilter(tag.type, tag.value)}
                      >
                        {tag.value} &times;
                      </button>
                    ))}
                  </div>
                  <button type="button" className="search-clear-filters" onClick={clearFilters}>
                    清除筛选
                  </button>
                </div>
              ) : (
                <span />
              )}
              <span className="search-results-count">
                {hasActiveFilters
                  ? `${filteredVariantCount} / ${totalVariantCount} 个结果`
                  : `${totalVariantCount} 个结果`}
              </span>
            </div>
          </section>
        )}

        {/* 结果区 */}
        <div className="search-results">
          {/* 失败态（连接/服务端错误，区别于零匹配） */}
          {!loading && searchFailed ? (
            <Alert type="error" showIcon message="搜索失败，请检查连接后重试。" />
          ) : loading && groupedResults.length === 0 ? (
            /* 加载骨架屏 */
            <div className="search-bangumi-list">
              {[0, 1, 2].map((i) => (
                <div key={i} className="search-bangumi-row">
                  <Skeleton.Node active style={{ width: 120, height: 168, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Skeleton active title={{ width: '40%' }} paragraph={{ rows: 3 }} />
                  </div>
                </div>
              ))}
            </div>
          ) : groupedResults.length > 0 ? (
            /* 按 official_title 分组的番剧列表 */
            <div className="search-bangumi-list">
              {groupedResults.map((group) => {
                const filtered = getFilteredVariants(group);
                if (filtered.length === 0) return null;
                const visible = getVisibleVariants(group);
                const overflow = filtered.length - MAX_VISIBLE_VARIANTS;
                const expanded = expandedVariants.has(group.key);
                return (
                  <div key={group.key} className="search-bangumi-row">
                    {/* 左：海报 */}
                    <div className="search-bangumi-poster">
                      {group.poster_link ? (
                        <img
                          src={resolvePosterUrl(group.poster_link)}
                          alt={group.official_title}
                          loading="lazy"
                        />
                      ) : (
                        <div className="search-bangumi-poster-placeholder">
                          <span>{group.official_title}</span>
                        </div>
                      )}
                    </div>

                    {/* 右：标题/年份/变体数 + 变体卡片 */}
                    <div className="search-bangumi-body">
                      <div className="search-bangumi-head">
                        <span className="search-bangumi-title" title={group.official_title}>
                          {group.official_title}
                        </span>
                        {group.year && <span className="search-bangumi-year">{group.year}</span>}
                        <span className="search-variant-count">
                          {filtered.length} 个版本
                        </span>
                      </div>
                      <div className="search-variant-list">
                        {visible.map((variant) => (
                          <SearchVariantCard
                            key={variant.rss_link[0] || variant.title_raw}
                            variant={variant}
                            onSelect={selectResult}
                          />
                        ))}
                        {overflow > 0 && (
                          <button
                            type="button"
                            className="search-variant-expand"
                            onClick={() => toggleVariantsExpand(group.key)}
                          >
                            {expanded ? '收起' : `+${overflow}`}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : keyword ? (
            /* 空态：有搜索词但零匹配 */
            <div className="search-empty">
              <Empty description="未找到相关结果，试试其他关键词" />
            </div>
          ) : (
            /* 初始态 */
            <div className="search-empty">
              <Empty description="输入关键词开始搜索" />
            </div>
          )}
        </div>
      </Modal>

      {/* 点选变体后的订阅确认弹窗 */}
      <SearchConfirm />
    </>
  );
}
