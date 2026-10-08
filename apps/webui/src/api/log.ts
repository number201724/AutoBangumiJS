/** Log endpoints — mirrors webui/src/api/log.ts. */
import { api } from './client';

export const apiLog = {
  async get() {
    const { data } = await api.get<string>('api/v1/log', { silent: true });
    return data;
  },
  async clear() {
    const { data } = await api.post('api/v1/log/clear');
    return data;
  },
};
