/** Update endpoints — mirrors webui/src/api/update.ts. */
import { api } from './client';

export interface UpdateCheckResult {
  error: string | null;
  has_update: boolean;
  current: string;
  latest: string | null;
  channel: string;
  notes: string | null;
  overlay?: unknown;
}

export const apiUpdate = {
  async check(channel?: string, force = false) {
    const { data } = await api.get<UpdateCheckResult>('api/v1/update/check', {
      params: { channel, force },
      silent: true,
    });
    return data;
  },
  async apply(channel?: string) {
    const { data } = await api.post('api/v1/update/apply', undefined, {
      params: { channel },
    });
    return data;
  },
  async rollback() {
    const { data } = await api.post('api/v1/update/rollback');
    return data;
  },
};
