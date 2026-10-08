/**
 * WebAuthn browser service — React port of webui/src/services/webauthn.ts
 * and hooks/usePasskey.ts (buffer handling delegated to @simplewebauthn/browser).
 */
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

import { api } from './client';

const KNOWN_PASSKEY_KEY = 'hasPasskey';

export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.PublicKeyCredential &&
    typeof navigator.credentials?.create === 'function'
  );
}

export function hasKnownPasskey(): boolean {
  return localStorage.getItem(KNOWN_PASSKEY_KEY) === 'true';
}

function markKnownPasskey(v: boolean): void {
  localStorage.setItem(KNOWN_PASSKEY_KEY, v ? 'true' : 'false');
}

/** 注册新的 Passkey（需要浏览器会话）。 */
export async function registerPasskey(deviceName: string): Promise<void> {
  const options = await api.post<PublicKeyCredentialCreationOptionsJSON>(
    'api/v1/passkey/register/options',
  );
  let attestation;
  try {
    attestation = await startRegistration({ optionsJSON: options.data });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') {
      throw new Error('Authentication was cancelled or timed out');
    }
    throw e;
  }
  await api.post('api/v1/passkey/register/verify', {
    name: deviceName,
    attestation_response: attestation,
  });
  markKnownPasskey(true);
}

/**
 * Passkey 登录。username 为空走可发现凭证（浏览器弹出账户选择器）。
 * silent=true 时取消不报错（用于自动弹出场景）。
 */
export async function loginWithPasskey(
  username: string | undefined,
  opts: { silent?: boolean } = {},
): Promise<boolean> {
  try {
    const options = await api.post<PublicKeyCredentialRequestOptionsJSON>(
      'api/v1/passkey/auth/options',
      { username: username ?? null },
      { silent: opts.silent },
    );
    const credential = await startAuthentication({ optionsJSON: options.data });
    await api.post(
      'api/v1/passkey/auth/verify',
      { username: username ?? null, credential },
      { silent: opts.silent },
    );
    markKnownPasskey(true);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') {
      // 用户取消：静默回落到密码表单，并解除自动弹出
      if (opts.silent) markKnownPasskey(false);
      return false;
    }
    if (opts.silent) return false;
    throw e;
  }
}

/** 主动登出后，下一次到登录页不自动弹出 passkey。 */
export function suppressPasskeyAutoPromptOnce(): void {
  sessionStorage.setItem('suppressPasskeyAutoPrompt', '1');
}
