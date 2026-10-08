/** Notification endpoints — mirrors webui/src/api/notification.ts. */
import { api } from './client';
import type { InboxMessage, NotificationProviderConfig } from '@ab/types';

export interface TestResult {
  success: boolean;
  message: string;
  message_zh: string;
  message_en: string;
}

export const apiNotification = {
  async test(providerIndex: number) {
    const { data } = await api.post<TestResult>('api/v1/notification/test', {
      provider_index: providerIndex,
    });
    return data;
  },
  async testConfig(config: NotificationProviderConfig) {
    const { data } = await api.post<TestResult>('api/v1/notification/test-config', config);
    return data;
  },
  async listMessages(unreadOnly = false, limit = 50, offset = 0) {
    const { data } = await api.get<{
      messages: InboxMessage[];
      total: number;
      unread_count: number;
    }>('api/v1/notification/messages', {
      params: { unread_only: unreadOnly, limit, offset },
    });
    return data;
  },
  async unreadCount() {
    const { data } = await api.get<{ unread_count: number }>(
      'api/v1/notification/messages/unread-count',
      { silent: true },
    );
    return data;
  },
  async markAllRead() {
    const { data } = await api.post('api/v1/notification/messages/read-all');
    return data;
  },
  async markRead(id: number) {
    const { data } = await api.post(`api/v1/notification/messages/${id}/read`);
    return data;
  },
  async deleteMessage(id: number) {
    const { data } = await api.delete(`api/v1/notification/messages/${id}`);
    return data;
  },
  async clearMessages() {
    const { data } = await api.delete('api/v1/notification/messages');
    return data;
  },
};
