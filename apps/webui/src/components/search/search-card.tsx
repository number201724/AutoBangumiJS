/**
 * 搜索结果变体卡片 — 对应 Vue 版弹窗内的 variant-chip：
 * 一个字幕组发布版本 = 一枚可点击芯片，展示 字幕组/分辨率/字幕/季度/来源 彩色标签，
 * 点击后进入订阅确认弹窗。归一化展示逻辑在 stores/search.ts。
 */
import {
  getResolution,
  getSeason,
  getSubtitle,
  type SearchVariant,
} from '@/stores/search';

interface SearchVariantCardProps {
  variant: SearchVariant;
  onSelect: (variant: SearchVariant) => void;
}

export function SearchVariantCard({ variant, onSelect }: SearchVariantCardProps) {
  const resolution = getResolution(variant);
  const subtitle = getSubtitle(variant);
  const season = getSeason(variant);

  return (
    <button
      type="button"
      className="search-variant-chip"
      onClick={() => onSelect(variant)}
    >
      <span className="search-tag search-tag--group">{variant.group_name || '未知字幕组'}</span>
      {resolution && <span className="search-tag search-tag--resolution">{resolution}</span>}
      {subtitle && <span className="search-tag search-tag--subtitle">{subtitle}</span>}
      {season && <span className="search-tag search-tag--season">{season}</span>}
      {variant.source && <span className="search-tag search-tag--source">{variant.source}</span>}
    </button>
  );
}
