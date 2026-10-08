/**
 * Auth store — mirrors the Vue webui's useAuth composable + session state.
 */
import { create } from 'zustand';

import { api } from '@/api/client';
import { suppressPasskeyAutoPromptOnce } from '@/api/passkey';

interface AuthState {
  isLoggedIn: boolean;
  username: string;
  setLoggedIn: (v: boolean) => void;
  setUsername: (v: string) => void;
  /** Startup session refresh; silent — a 401 must not flash an error toast. */
  refresh: () => Promise<boolean>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  isLoggedIn: false,
  username: '',
  setLoggedIn: (v) => set({ isLoggedIn: v }),
  setUsername: (v) => set({ username: v }),
  refresh: async () => {
    try {
      await api.post('api/v1/auth/refresh_token', undefined, { silent: true });
      const { data } = await api.get<{ username: string }>('api/v1/auth/me', { silent: true });
      set({ isLoggedIn: true, username: data.username });
      return true;
    } catch {
      set({ isLoggedIn: false, username: '' });
      return false;
    }
  },
  logout: async () => {
    try {
      await api.post('api/v1/auth/logout');
    } finally {
      // 主动登出后的那一次跳转不自动弹 passkey（对齐 Vue useAuth）
      suppressPasskeyAutoPromptOnce();
      set({ isLoggedIn: false, username: '' });
      window.location.hash = '#/login';
    }
  },
}));
