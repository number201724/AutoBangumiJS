/** User/token management endpoints — mirrors webui/src/api/access.ts. */
import { api } from './client';
import type { ApiTokenCreated, ApiTokenPublic, UserPublic } from '@ab/types';

export const apiUsers = {
  async list() {
    const { data } = await api.get<UserPublic[]>('api/v1/users');
    return data;
  },
  async create(username: string, password: string) {
    const { data } = await api.post<UserPublic>('api/v1/users', { username, password });
    return data;
  },
  async update(userId: number, payload: { username?: string; password?: string; enabled?: boolean }) {
    const { data } = await api.patch<UserPublic>(`api/v1/users/${userId}`, payload);
    return data;
  },
  async delete(userId: number) {
    await api.delete(`api/v1/users/${userId}`);
  },
};

export const apiTokens = {
  async list() {
    const { data } = await api.get<ApiTokenPublic[]>('api/v1/tokens');
    return data;
  },
  async create(name: string, scope: 'api' | 'mcp', expiresAt?: string | null) {
    const { data } = await api.post<ApiTokenCreated>('api/v1/tokens', {
      name,
      scope,
      expires_at: expiresAt ?? null,
    });
    return data;
  },
  async revoke(tokenId: number) {
    await api.delete(`api/v1/tokens/${tokenId}`);
  },
};
