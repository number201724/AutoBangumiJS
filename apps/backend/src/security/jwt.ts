/**
 * JWT HS256 — 1:1 port of module/security/jwt.py (legacy-compat path only;
 * new sessions are opaque DB-persisted tokens). Implemented with node:crypto
 * to avoid a dependency.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SECRET_PATH = path.join('config', '.jwt_secret');

function loadOrCreateSecret(): string {
  if (fs.existsSync(SECRET_PATH)) {
    return fs.readFileSync(SECRET_PATH, 'utf-8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

export const appPwdKey = loadOrCreateSecret();
export const APP_PWD_ALGORITHM = 'HS256';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', appPwdKey).update(data).digest('base64url');
}

export interface JwtPayload {
  sub?: string;
  exp?: number;
  [key: string]: unknown;
}

/** Create a JWT (mirrors create_access_token; default expiry 1440 minutes). */
export function createAccessToken(data: JwtPayload, expiresMinutes = 1440): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + expiresMinutes * 60 }),
  );
  return `${header}.${payload}.${hmac(`${header}.${payload}`)}`;
}

/** Decode + verify a JWT (algorithm pinned to HS256; exp enforced). */
export function decodeToken(token: string | null | undefined): JwtPayload | null {
  if (!token) return null;
  try {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) return null;
    const headerObj = JSON.parse(Buffer.from(header, 'base64url').toString()) as {
      alg?: string;
    };
    // 显式校验算法，防止算法混淆攻击
    if (headerObj.alg !== APP_PWD_ALGORITHM) return null;
    const expected = hmac(`${header}.${payload}`);
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()) as JwtPayload;
    if (typeof obj.exp === 'number' && obj.exp * 1000 <= Date.now()) return null;
    if (obj.sub === undefined || obj.sub === null) return null;
    return obj;
  } catch {
    return null;
  }
}

export function verifyToken(token: string | null | undefined): JwtPayload | null {
  return decodeToken(token);
}
