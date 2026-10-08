/**
 * Passkey authentication strategy — 1:1 port of module/security/auth_strategy.py.
 */
import { db } from '../database/facade';
import type { WebAuthnService } from './webauthn';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export interface StrategyResponse {
  status_code: number;
  status: boolean;
  msg_en: string;
  msg_zh: string;
  data?: { user_id: number; username: string; credential_id: string } | null;
}

export class PasskeyAuthStrategy {
  constructor(private readonly webauthnService: WebAuthnService) {}

  /**
   * 使用 WebAuthn Passkey 认证。username 为 null 时使用可发现凭证模式。
   */
  async authenticate(
    username: string | null,
    credential: AuthenticationResponseJSON,
  ): Promise<StrategyResponse> {
    // 1. 提取 credential_id
    let credentialId: string;
    try {
      const rawId = credential.rawId;
      if (!rawId) throw new Error('Missing credential ID');
      // Normalize to canonical base64url
      credentialId = Buffer.from(rawId, 'base64url').toString('base64url');
    } catch {
      return {
        status_code: 401,
        status: false,
        msg_en: 'Invalid passkey credential',
        msg_zh: 'Passkey 凭证无效',
      };
    }

    // Passkey verification updates the signature counter; BEGIN IMMEDIATE
    // prevents a WAL snapshot-upgrade failure between SELECT and UPDATE.
    return await db.inWriteTransactionAsync(async (d) => {
      // 2. 查找 passkey
      const passkey = d.passkey.getPasskeyByCredentialId(credentialId);
      if (!passkey) {
        return { status_code: 401, status: false, msg_en: 'Passkey not found', msg_zh: '未找到 Passkey' };
      }

      // 3. 获取用户
      const user = d.user.getUserById(passkey.user_id);
      if (!user || !user.enabled) {
        return { status_code: 401, status: false, msg_en: 'User not found', msg_zh: '用户不存在' };
      }

      // 4. 如果提供了 username，验证一致性
      if (username && user.username !== username) {
        return {
          status_code: 401,
          status: false,
          msg_en: 'Passkey does not belong to specified user',
          msg_zh: 'Passkey 不属于指定用户',
        };
      }

      // 5. 验证 WebAuthn 签名
      try {
        const newSignCount = username
          ? await this.webauthnService.verifyAuthentication(username, credential, passkey)
          : await this.webauthnService.verifyDiscoverableAuthentication(credential, passkey);

        // 6. 更新使用记录
        d.passkey.updatePasskeyUsage(passkey, newSignCount);

        return {
          status_code: 200,
          status: true,
          msg_en: 'Login successfully with passkey',
          msg_zh: '通过 Passkey 登录成功',
          data: { user_id: user.id, username: user.username, credential_id: credentialId },
        };
      } catch (e) {
        return {
          status_code: 401,
          status: false,
          msg_en: `Passkey verification failed: ${String((e as Error).message)}`,
          msg_zh: `Passkey 验证失败: ${String((e as Error).message)}`,
        };
      }
    });
  }
}
