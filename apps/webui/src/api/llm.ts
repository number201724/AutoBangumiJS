/** LLM provider endpoints — mirrors webui/src/api/llm.ts. */
import { api } from './client';

export interface ProviderView {
  id: string;
  display_name: string;
  auth_kind: string;
  builtin: boolean;
  needs_base_url: boolean;
  preset_base_url: string;
  default_model: string;
  plugin_version: string | null;
  connected: boolean;
  account_label: string;
  expires_at: number | null;
}

export interface AuthBeginResult {
  method: string;
  authorize_url: string | null;
  user_code: string | null;
  verification_uri: string | null;
  expires_in: number;
  state: string;
}

export const apiLlm = {
  async listProviders() {
    const { data } = await api.get<{ providers: ProviderView[] }>('api/v1/config/llm/providers');
    return data.providers;
  },
  async install(providerId: string) {
    const { data } = await api.post(`api/v1/config/llm/providers/${providerId}/install`);
    return data;
  },
  async uninstall(providerId: string) {
    const { data } = await api.delete(`api/v1/config/llm/providers/${providerId}`);
    return data;
  },
  async authBegin(providerId: string) {
    const { data } = await api.post<AuthBeginResult>(
      `api/v1/config/llm/providers/${providerId}/auth/begin`,
    );
    return data;
  },
  async authComplete(providerId: string, state: string, code = '') {
    const { data } = await api.post(`api/v1/config/llm/providers/${providerId}/auth/complete`, {
      state,
      code,
    });
    return data;
  },
  async authStatus(providerId: string) {
    const { data } = await api.get<{
      connected: boolean;
      account_label: string;
      expires_at: number | null;
    }>(`api/v1/config/llm/providers/${providerId}/auth/status`);
    return data;
  },
  async authDisconnect(providerId: string) {
    const { data } = await api.delete(`api/v1/config/llm/providers/${providerId}/auth`);
    return data;
  },
};
