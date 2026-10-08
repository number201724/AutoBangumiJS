/**
 * /api/v1/auth — 1:1 port of module/api/auth.py.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
} from '../application/auth';
import { authService as defaultAuthService } from '../composition';
import { AuthGuard, LoginIpGuard, SessionGuard, type AuthPrincipal } from '../security/api';
import { toApiIso } from '../utils/time';
import { validatePassword, validateUsername } from './validators';

const TOKEN_MAX_AGE = 86400; // seconds

function issueSession(res: Response, token: string) {
  res.cookie('token', token, {
    httpOnly: true,
    maxAge: TOKEN_MAX_AGE * 1000,
    sameSite: 'strict',
  });
  return { authenticated: true };
}

function principalOf(req: Request): AuthPrincipal {
  return req.principal!;
}

@Controller('/api/v1/auth')
export class AuthController {
  /** OAuth2 form login -> HttpOnly cookie session. */
  @Post('/login')
  @UseGuards(LoginIpGuard)
  @HttpCode(200)
  login(
    @Body() body: { username?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // OAuth2PasswordRequestForm 只认 form-urlencoded，JSON body / 缺字段 → 422
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/x-www-form-urlencoded')) {
      throw new HttpException(
        { detail: [{ loc: ['body'], msg: 'Content-Type must be application/x-www-form-urlencoded', type: 'value_error' }] },
        422,
      );
    }
    if (body.username === undefined || body.password === undefined) {
      throw new HttpException(
        { detail: [{ loc: ['body'], msg: 'Field required', type: 'value_error.missing' }] },
        422,
      );
    }
    try {
      const { token } = defaultAuthService.login(body.username ?? '', body.password ?? '');
      return issueSession(res, token);
    } catch (e) {
      if (e instanceof AuthenticationError) {
        throw new HttpException('Invalid username or password', 401);
      }
      throw e;
    }
  }

  private refreshCookie(req: Request, res: Response) {
    const token = (req.cookies as Record<string, string | undefined>)?.token;
    if (!token) throw new HttpException('Unauthorized', 401);
    const user = defaultAuthService.refreshSession(token);
    if (user) {
      return issueSession(res, token);
    }
    throw new HttpException('Unauthorized', 401);
  }

  @Post('/refresh_token')
  @HttpCode(200)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.refreshCookie(req, res);
  }

  /** Compatibility alias; clients should use POST. */
  @Get('/refresh_token')
  @Header('Deprecation', 'true')
  @Header('Warning', '299 - "Use POST /auth/refresh_token"')
  refreshLegacyGet(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.refreshCookie(req, res);
  }

  @Post('/logout')
  @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string | undefined>)?.token;
    if (token) {
      defaultAuthService.logout(token);
    }
    res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
    return { status: true, msg_en: 'Logout successfully.', msg_zh: '登出成功。' };
  }

  @Get('/me')
  @UseGuards(AuthGuard)
  me(@Req() req: Request) {
    const principal = principalOf(req);
    if (!principal.user) {
      throw new HttpException('No database user for this session', 400);
    }
    const u = principal.user;
    return {
      id: u.id,
      username: u.username,
      enabled: u.enabled,
      created_at: toApiIso(u.created_at),
      updated_at: toApiIso(u.updated_at),
    };
  }

  /** Update the current account and rotate all of its sessions. */
  @Post('/update')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  updateUser(
    @Body() userData: { username?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const principal = principalOf(req);
    const user = principal.user;
    if (!user) {
      throw new HttpException('A browser session is required', 403);
    }
    // UserCredentialsUpdate is extra=forbid
    const extraKeys = Object.keys(userData).filter((k) => !['username', 'password'].includes(k));
    if (extraKeys.length) {
      throw new HttpException(`extra fields not permitted: ${extraKeys.join(', ')}`, 422);
    }
    // pydantic Field 约束：username 4-20 位 [a-zA-Z0-9_]、password ≥8（422）
    if (userData.username !== undefined) validateUsername(userData.username);
    if (userData.password !== undefined) validatePassword(userData.password);
    try {
      const { token } = defaultAuthService.updateCurrentUser(user.id, userData);
      return issueSession(res, token);
    } catch (e) {
      if (e instanceof AuthenticationError) throw new HttpException('Unauthorized', 401);
      if (e instanceof NotFoundError) throw new HttpException(e.message, 404);
      if (e instanceof ConflictError) throw new HttpException(e.message, 409);
      throw e;
    }
  }
}
