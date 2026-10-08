/** Passkey management endpoints (list/delete + register options). */
import { api } from './client';

export interface PasskeyItem {
  id: number;
  name: string;
  created_at: string | null;
  last_used_at: string | null;
  backup_eligible: boolean | null;
  aaguid: string | null;
}

export const apiPasskeyManage = {
  async list() {
    const { data } = await api.get<PasskeyItem[]>('api/v1/passkey/list');
    return data;
  },
  async delete(passkeyId: number) {
    const { data } = await api.post('api/v1/passkey/delete', { passkey_id: passkeyId });
    return data;
  },
};
