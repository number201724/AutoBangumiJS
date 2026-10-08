/** Setup wizard endpoints — mirrors webui/src/api/setup.ts. */
import { api } from './client';
import type { Config } from '@ab/types';

export interface TestResult {
  success: boolean;
  message_en: string;
  message_zh: string;
  title?: string | null;
  item_count?: number | null;
}

export const apiSetup = {
  async status() {
    const { data } = await api.get<{ need_setup: boolean; version: string }>(
      'api/v1/setup/status',
      { silent: true },
    );
    return data;
  },
  async testDownloader(downloader: Config['downloader']) {
    const { data } = await api.post<TestResult>('api/v1/setup/test-downloader', {
      type: downloader.type,
      host: downloader.host,
      username: downloader.username,
      password: downloader.password,
      ssl: downloader.ssl,
    });
    return data;
  },
  async testRss(url: string) {
    const { data } = await api.post<TestResult>('api/v1/setup/test-rss', { url });
    return data;
  },
  async testNotification(type: string, token: string, chatId = '') {
    const { data } = await api.post<TestResult>('api/v1/setup/test-notification', {
      type,
      token,
      chat_id: chatId,
    });
    return data;
  },
  async complete(payload: {
    username: string;
    password: string;
    downloader_type: string;
    downloader_host: string;
    downloader_username: string;
    downloader_password: string;
    downloader_path?: string;
    downloader_ssl?: boolean;
    rss_url?: string;
    rss_name?: string;
    notification_enable?: boolean;
    notification_type?: string;
    notification_token?: string;
    notification_chat_id?: string;
  }) {
    const { data } = await api.post('api/v1/setup/complete', payload);
    return data as { status: boolean; status_code: number; msg_en: string; msg_zh: string };
  },
};
