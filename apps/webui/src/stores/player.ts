/**
 * Player store — mirrors webui/src/store/player.ts (zustand port).
 * 与 Vue 版共用 localStorage 键（media-player-type / media-player-url），
 * 两个前端在同一浏览器下配置互通。
 */
import { create } from 'zustand';

export type MediaPlayerType = 'jump' | 'iframe';

const TYPE_KEY = 'media-player-type';
const URL_KEY = 'media-player-url';

/** 无协议地址补 http:// 前缀（与 Vue 版 normalizeUrl 一致）。 */
export function normalizeUrl(url: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function readType(): MediaPlayerType {
  return localStorage.getItem(TYPE_KEY) === 'iframe' ? 'iframe' : 'jump';
}

interface PlayerState {
  type: MediaPlayerType;
  rawUrl: string;
  setType: (t: MediaPlayerType) => void;
  setRawUrl: (v: string) => void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  type: readType(),
  rawUrl: localStorage.getItem(URL_KEY) ?? '',
  setType: (type) => {
    localStorage.setItem(TYPE_KEY, type);
    set({ type });
  },
  setRawUrl: (rawUrl) => {
    localStorage.setItem(URL_KEY, rawUrl);
    set({ rawUrl });
  },
}));
