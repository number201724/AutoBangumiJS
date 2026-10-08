/**
 * /api/v1/passkey — 1:1 port of module/api/passkey.py.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { authService } from '../composition';
import { AuthenticationError } from '../application/auth';
import { settings } from '../config/settings';
import { db } from '../database/facade';
import { AuthGuard, LoginIpGuard, SessionGuard } from '../security/api';
import { PasskeyAuthStrategy } from '../security/auth-strategy';
import { getWebauthnService } from '../security/webauthn';
import { utcNow } from '../utils/time';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

const GENERIC_ERROR = 'Internal server error.';

import { Logger } from '@nestjs/common';
const logger = new Logger('PasskeyAPI');

/**
 * 从请求中构造 WebAuthnService：若配置了 webauthn_rp_id/webauthn_origin
 * 直接使用；否则从请求头推断（Origin -> Referer -> Host）。
 */
function webauthnFromRequest(req: Request) {
  let origin = settings.data.security.webauthn_origin;
  if (!origin) {
    origin = (req.headers.origin as string) ?? '';
    if (!origin) {
      const referer = (req.headers.referer as string) ?? '';
      if (referer) {
        // Python urlparse 对畸形 Referer 容忍（netloc 为空也不抛）
        try {
          const parsed = new URL(referer);
          origin = `${parsed.protocol}//${parsed.host}`;
        } catch {
          origin = '';
        }
      }
      if (!origin) {
        const host = (req.headers.host as string) ?? 'localhost:7892';
        const scheme = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
        origin = `${scheme}://${host}`;
      }
    }
  }
  let rpId = settings.data.security.webauthn_rp_id;
  if (!rpId) {
    try {
      rpId = new URL(origin).hostname || 'localhost';
    } catch {
      rpId = 'localhost';
    }
  }
  return getWebauthnService(rpId, 'AutoBangumi', origin);
}

@Controller('/api/v1/passkey')
export class PasskeyController {
  // ============ 注册流程 ============

  @Post('/register/options')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async getRegistrationOptions(@Req() req: Request) {
    const webauthn = webauthnFromRequest(req);
    const user = req.principal?.user;
    if (!user) throw new HttpException('A browser session is required', 403);
    try {
      const existingPasskeys = db.passkey.getPasskeysByUserId(user.id);
      return await webauthn.generateRegistrationOptions(user.username, user.id, existingPasskeys);
    } catch (e) {
      logger.error(`Failed to generate registration options: ${e}`);
      throw new HttpException(GENERIC_ERROR, 500);
    }
  }

  @Post('/register/verify')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async verifyRegistration(
    @Body() body: { name: string; attestation_response: RegistrationResponseJSON },
    @Req() req: Request,
  ) {
    const webauthn = webauthnFromRequest(req);
    const user = req.principal?.user;
    if (!user) throw new HttpException('A browser session is required', 403);
    try {
      const verified = await webauthn.verifyRegistration(
        user.username,
        body.attestation_response,
        body.name,
      );
      db.passkey.createPasskey({
        user_id: user.id,
        name: body.name,
        credential_id: verified.credentialId,
        public_key: verified.publicKey,
        sign_count: verified.signCount,
        aaguid: verified.aaguid,
        transports: JSON.stringify(
          body.attestation_response.response.transports ?? [],
        ),
        created_at: utcNow(),
        last_used_at: null,
        backup_eligible: verified.backupEligible,
        backup_state: verified.backupState,
      });
      return {
        msg_en: `Passkey '${body.name}' registered successfully`,
        msg_zh: `Passkey '${body.name}' 注册成功`,
      };
    } catch (e) {
      if (e instanceof Error && e.name === 'ValueError') {
        logger.warn(`Registration verification failed for ${user.username}: ${e}`);
        throw new HttpException(e.message, 400);
      }
      if (e instanceof HttpException) throw e;
      logger.error(`Failed to register passkey: ${e}`);
      throw new HttpException(GENERIC_ERROR, 500);
    }
  }

  // ============ 认证流程 ============

  @Post('/auth/options')
  @UseGuards(LoginIpGuard)
  @HttpCode(200)
  async getPasskeyLoginOptions(@Body() body: { username?: string | null }, @Req() req: Request) {
    const webauthn = webauthnFromRequest(req);

    // Discoverable credentials mode (no username)
    if (!body.username) {
      try {
        return await webauthn.generateDiscoverableAuthenticationOptions();
      } catch (e) {
        logger.error(`Failed to generate discoverable login options: ${e}`);
        throw new HttpException(GENERIC_ERROR, 500);
      }
    }

    // Username-based mode
    try {
      const user = db.user.findUser(body.username);
      const passkeys = user ? db.passkey.getPasskeysByUserId(user.id) : [];
      if (!user || !passkeys.length) {
        // Same response whether the username doesn't exist or simply has no
        // passkeys registered — cannot be used to enumerate valid usernames.
        throw new HttpException('No passkeys available for this username.', 400);
      }
      return await webauthn.generateAuthenticationOptions(body.username, passkeys);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      logger.error(`Failed to generate login options: ${e}`);
      throw new HttpException(GENERIC_ERROR, 500);
    }
  }

  @Post('/auth/verify')
  @UseGuards(LoginIpGuard)
  @HttpCode(200)
  async loginWithPasskey(
    @Body() body: { username?: string | null; credential: AuthenticationResponseJSON },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const webauthn = webauthnFromRequest(req);
    const strategy = new PasskeyAuthStrategy(webauthn);
    const resp = await strategy.authenticate(body.username ?? null, body.credential);

    if (resp.status && !resp.data) {
      // Python 同分支：身份字段缺失 → 500
      throw new HttpException('Failed to determine passkey identity', 500);
    }
    if (resp.status && resp.data) {
      const { user_id: userId, credential_id: credentialId } = resp.data;
      try {
        const token = authService.issueSessionForVerifiedPasskey(userId, credentialId);
        res.cookie('token', token, {
          httpOnly: true,
          maxAge: 86400 * 1000,
          sameSite: 'strict',
        });
        return { authenticated: true };
      } catch (e) {
        if (e instanceof AuthenticationError) {
          throw new HttpException('User is not available', 401);
        }
        throw e;
      }
    }
    throw new HttpException(resp.msg_en, resp.status_code);
  }

  // ============ Passkey 管理 ============

  @Get('/list')
  @UseGuards(SessionGuard)
  listPasskeys(@Req() req: Request) {
    const user = req.principal?.user;
    if (!user) throw new HttpException('A browser session is required', 403);
    try {
      const passkeys = db.passkey.getPasskeysByUserId(user.id);
      return passkeys.map((pk) => db.passkey.toListModel(pk));
    } catch (e) {
      logger.error(`Failed to list passkeys: ${e}`);
      throw new HttpException(GENERIC_ERROR, 500);
    }
  }

  @Post('/delete')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  deletePasskey(@Body() body: { passkey_id: number }, @Req() req: Request) {
    const user = req.principal?.user;
    if (!user) throw new HttpException('A browser session is required', 403);
    try {
      db.passkey.deletePasskey(body.passkey_id, user.id);
      return { msg_en: 'Passkey deleted successfully', msg_zh: 'Passkey 删除成功' };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      logger.error(`Failed to delete passkey: ${e}`);
      throw new HttpException(GENERIC_ERROR, 500);
    }
  }
}
