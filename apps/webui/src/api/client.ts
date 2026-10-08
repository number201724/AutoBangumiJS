/**
 * Axios client — ports the Vue webui's utils/axios.ts interceptor semantics:
 * - 401: drop the login flag and route back to #/login (except when already there)
 * - throttled error toasts (4s) via antd message
 * - `silent: true` config opt-out of toasts (auth side effect still applies)
 */
import Axios, { type AxiosError, type AxiosResponse } from 'axios';
import { message } from 'antd';

import { useAuthStore } from '@/stores/auth';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** Suppress the interceptor's error toast — the caller surfaces failures itself. */
    silent?: boolean;
  }
}

export const api = Axios.create({
  withCredentials: true,
});

export interface ApiError {
  status: number;
  msg_en: string;
  msg_zh: string;
  detail?: string;
}

const recentToastAt = new Map<string, number>();
const TOAST_THROTTLE_MS = 4000;

function showErrorThrottled(msg: string): void {
  const now = Date.now();
  const last = recentToastAt.get(msg) ?? 0;
  if (now - last < TOAST_THROTTLE_MS) return;
  recentToastAt.set(msg, now);
  void message.error(msg);
}

function normalizeDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail.trim();
  if (!Array.isArray(detail)) return '';
  return detail
    .map((issue) => {
      if (typeof issue === 'string') return issue.trim();
      if (!issue || typeof issue !== 'object') return '';
      const candidate = issue as { loc?: unknown; msg?: unknown };
      const m = typeof candidate.msg === 'string' ? candidate.msg.trim() : '';
      if (!m) return '';
      const location = Array.isArray(candidate.loc)
        ? candidate.loc.filter((p) => p !== 'body').map(String).join('.')
        : '';
      return location ? `${location}: ${m}` : m;
    })
    .filter(Boolean)
    .join('; ');
}

/** A 401 means the session is gone — drop the flag and get back to login. */
function handleAuthExpired(): void {
  useAuthStore.getState().setLoggedIn(false);
  if (!window.location.hash.startsWith('#/login')) {
    window.location.hash = '#/login';
  }
}

export function onResponseError(err: AxiosError): Promise<never> {
  const status = err.response?.status ?? 0;
  const responseData = err.response?.data as
    | { msg_en?: string; msg_zh?: string; detail?: unknown }
    | undefined;
  const msgEn = typeof responseData?.msg_en === 'string' ? responseData.msg_en : '';
  const msgZh = typeof responseData?.msg_zh === 'string' ? responseData.msg_zh : '';
  const detail = normalizeDetail(responseData?.detail);
  const errorMsg = msgZh || msgEn || detail;

  const silent = err.config?.silent === true;

  const error: ApiError = { status, msg_en: msgEn, msg_zh: msgZh, ...(detail ? { detail } : {}) };

  if (!err.response) {
    if (!silent) showErrorThrottled('网络错误，请检查连接。');
    return Promise.reject({ status: 0, msg_en: 'Network error', msg_zh: '网络错误' } satisfies ApiError);
  }

  if (silent) {
    if (status === 401) handleAuthExpired();
    return Promise.reject(error);
  }

  switch (status) {
    case 401:
      handleAuthExpired();
      showErrorThrottled(errorMsg || '身份验证失败，请检查凭据或重新登录。');
      break;
    case 406:
      if (errorMsg) showErrorThrottled(errorMsg);
      break;
    case 500:
      showErrorThrottled(errorMsg || '服务器错误，请稍后重试。');
      break;
    default:
      showErrorThrottled(errorMsg || '请求失败，请重试。');
      break;
  }

  return Promise.reject(error);
}

api.interceptors.response.use((res: AxiosResponse) => res, onResponseError);
