/**
 * Auth guards/helpers — 1:1 port of module/security/api.py onto NestJS.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { authService } from '../composition';
import { settings } from '../config/settings';
import { db } from '../database/facade';
import type { UserRow } from '../database/schema';
import { isAllowed } from './ip-allowlist';
import { verifyToken, type JwtPayload } from './jwt';

import { Logger } from '@nestjs/common';

const logger = new Logger('Security');

// ---------------------------------------------------------------------------
// SessionStore (legacy in-memory registry of active usernames)
// ---------------------------------------------------------------------------

const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000; // 1 day

export class SessionStore {
  private sessions = new Map<string, number>();

  add(username: string): void {
    this.sessions.set(username, Date.now());
  }

  remove(username: string): void {
    this.sessions.delete(username);
  }

  clear(): void {
    this.sessions.clear();
  }

  has(username: string): boolean {
    const issued = this.sessions.get(username);
    if (issued === undefined) return false;
    if (Date.now() - issued >= SESSION_LIFETIME_MS) {
      this.sessions.delete(username);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.sessions.size;
  }
}

export const activeUser = new SessionStore();

// Opt-in only: AB_DEV_NO_AUTH=1 bypasses auth (must never be set in production).
export const DEV_AUTH_BYPASS = process.env.AB_DEV_NO_AUTH === '1';

if (DEV_AUTH_BYPASS) {
  logger.warn(
    '!!! AB_DEV_NO_AUTH=1 is set — authentication is BYPASSED for every ' +
      'request. This must never be set in production. !!!',
  );
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

export enum CredentialKind {
  SESSION = 'session',
  API_TOKEN = 'api_token',
  DEVELOPMENT = 'development',
}

export interface AuthPrincipal {
  username: string;
  kind: CredentialKind;
  user: UserRow | null;
}

declare module 'express' {
  interface Request {
    principal?: AuthPrincipal;
  }
}

/**
 * Resolve one supported credential into a typed principal (1:1 get_principal):
 * 1. DEV_AUTH_BYPASS
 * 2. Authorization: Bearer <scope=api token>
 * 3. HttpOnly cookie `token` session
 */
export async function resolvePrincipal(request: Request): Promise<AuthPrincipal> {
  if (DEV_AUTH_BYPASS) {
    return { username: 'dev_user', kind: CredentialKind.DEVELOPMENT, user: null };
  }

  const authHeader = (request.headers.authorization ?? '') as string;
  if (authHeader) {
    const [scheme, ...rest] = authHeader.split(' ');
    const apiTokenValue = rest.join(' ');
    if (!rest.length || scheme.toLowerCase() !== 'bearer' || !apiTokenValue) {
      throw new UnauthorizedException('Unauthorized');
    }
    const user = authService.authenticateApiToken(apiTokenValue, 'api');
    if (user) {
      return { username: user.username, kind: CredentialKind.API_TOKEN, user };
    }
    throw new UnauthorizedException('Unauthorized');
  }

  const token = (request.cookies as Record<string, string | undefined>)?.token;
  if (!token) {
    throw new UnauthorizedException('Unauthorized');
  }
  const user = authService.authenticateSession(token);
  if (user) {
    return { username: user.username, kind: CredentialKind.SESSION, user };
  }
  throw new UnauthorizedException('Unauthorized');
}

/** Guard equivalent to Depends(get_principal). */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    request.principal = await resolvePrincipal(request);
    return true;
  }
}

/** Guard equivalent to Depends(require_session_principal). */
@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.principal ?? (await resolvePrincipal(request));
    request.principal = principal;
    if (principal.kind !== CredentialKind.SESSION || !principal.user) {
      throw new ForbiddenException('A browser session is required for this operation');
    }
    return true;
  }
}

/**
 * Login IP whitelist guard (check_login_ip). Empty whitelist = allow all.
 */
@Injectable()
export class LoginIpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const whitelist = settings.data.security.login_whitelist;
    if (!whitelist.length) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const clientHost = request.ip;
    if (!clientHost || !isAllowed(clientHost, whitelist)) {
      throw new ForbiddenException('IP not in login whitelist');
    }
    return true;
  }
}

/** FastAPI dependency get_token_data — decodes the OAuth2 bearer JWT (legacy). */
export function getTokenData(authHeader: string | undefined): JwtPayload {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const payload = verifyToken(token);
  if (!payload) {
    throw new UnauthorizedException('invalid token');
  }
  return payload;
}

/** Verify credentials and register the user in activeUser on success. */
export function authUser(username: string, password: string | undefined) {
  const resp = db.user.authUser(username, password);
  if (resp.status) {
    activeUser.add(username);
  }
  return resp;
}

/** Persist updated credentials for currentUser. */
export function updateUserInfo(
  userData: {
    username?: string | null;
    password?: string | null;
    enabled?: boolean | null;
  },
  currentUser: string,
): boolean {
  try {
    db.user.updateUser(currentUser, userData);
    return true;
  } catch (e) {
    throw new HttpException(String(e), HttpStatus.BAD_REQUEST);
  }
}
