/** Config endpoints — mirrors webui/src/api/config.ts. */
import { api } from './client';
import type { Config } from '@ab/types';

export const apiConfig = {
  async get() {
    const { data } = await api.get<Config>('api/v1/config/get');
    return data;
  },
  async update(config: Config) {
    const { data } = await api.patch('api/v1/config/update', config);
    return data;
  },
  async listLlmModels(provider: string, apiKey: string, baseUrl: string) {
    const { data } = await api.post<{ models: string[] }>(
      'api/v1/config/llm/models',
      {
        provider,
        api_key: apiKey,
        base_url: baseUrl,
      },
      { silent: true },
    );
    return data.models;
  },
};
