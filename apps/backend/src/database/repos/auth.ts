/**
 * Session/API-token persistence — 1:1 port of module/database/auth.py.
 * Stores only SHA-256 token digests.
 */
import * as crypto from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import { getDb, getSqlite } from '../database';
import { apiToken, authSession, passkey, user } from '../schema';
import type { AuthSessionRow, ApiTokenRow, UserRow } from '../schema';
import { parseStoredTime, utcInSeconds, utcNow } from '../../utils/time';

export const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60; // 1 day

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

function legacyTokenFingerprint(tokenHash: string): string {
  return `legacy_${tokenHash.slice(0, 8)}`;
}

function tokenUrlsafe(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export class AuthDatabase {
  private get db() {
    return getDb();
  }

  createSession(
    userId: number,
    ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
  ): string {
    const rawToken = tokenUrlsafe(48);
    const now = utcNow();
    this.db
      .insert(authSession)
      .values({
        user_id: userId,
        token_hash: hashToken(rawToken),
        created_at: now,
        last_seen_at: now,
        expires_at: utcInSeconds(ttlSeconds),
      })
      .run();
    return rawToken;
  }

  authenticateSession(rawToken: string): UserRow | undefined {
    if (!rawToken) return undefined;
    const session = this.db
      .select()
      .from(authSession)
      .where(
        and(
          eq(authSession.token_hash, hashToken(rawToken)),
          isNull(authSession.revoked_at),
        ),
      )
      .get();
    if (!session) return undefined;
    const expires = parseStoredTime(session.expires_at);
    if (!expires || expires.getTime() <= Date.now()) return undefined;
    const u = this.db.select().from(user).where(eq(user.id, session.user_id)).get();
    if (!u || !u.enabled) return undefined;
    return u;
  }

  refreshSession(
    rawToken: string,
    ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
  ): UserRow | undefined {
    // Python 语义（auth.py:85-112）：禁用/删除用户时回滚——会话过期时间
    // 不得被延长。先校验会话与用户，全部通过后再 UPDATE。
    const now = utcNow();
    const session = this.db
      .select()
      .from(authSession)
      .where(
        and(
          eq(authSession.token_hash, hashToken(rawToken)),
          isNull(authSession.revoked_at),
          gt(authSession.expires_at, now),
        ),
      )
      .get();
    if (!session) return undefined;
    const u = this.db.select().from(user).where(eq(user.id, session.user_id)).get();
    if (!u || !u.enabled) return undefined;
    this.db
      .update(authSession)
      .set({ last_seen_at: now, expires_at: utcInSeconds(ttlSeconds) })
      .where(eq(authSession.id, session.id))
      .run();
    return u;
  }

  revokeSession(rawToken: string): boolean {
    if (!rawToken) return false;
    const result = this.db
      .update(authSession)
      .set({ revoked_at: utcNow() })
      .where(and(eq(authSession.token_hash, hashToken(rawToken)), isNull(authSession.revoked_at)))
      .run();
    return result.changes > 0;
  }

  revokeUserSessions(userId: number): number {
    const result = this.db
      .update(authSession)
      .set({ revoked_at: utcNow() })
      .where(and(eq(authSession.user_id, userId), isNull(authSession.revoked_at)))
      .run();
    return result.changes;
  }

  createApiToken(
    userId: number,
    name: string,
    scope: string,
    expiresAt?: string | null,
  ): { token: ApiTokenRow; rawToken: string } {
    if (scope !== 'api' && scope !== 'mcp') {
      throw new Error('Unsupported API token scope');
    }
    const rawToken = `ab_${scope}_${tokenUrlsafe(36)}`;
    this.db
      .insert(apiToken)
      .values({
        user_id: userId,
        name,
        scope,
        token_hash: hashToken(rawToken),
        prefix: rawToken.slice(0, 12),
        created_at: utcNow(),
        expires_at: expiresAt ?? null,
      })
      .run();
    const token = this.db
      .select()
      .from(apiToken)
      .where(and(eq(apiToken.token_hash, hashToken(rawToken)), eq(apiToken.scope, scope)))
      .get()!;
    return { token, rawToken };
  }

  /** Import a legacy plaintext token as a hashed API token (idempotent). */
  importApiToken(userId: number, rawToken: string, name: string, scope: string): ApiTokenRow {
    if (scope !== 'api' && scope !== 'mcp') {
      throw new Error('Unsupported API token scope');
    }
    const tokenHash = hashToken(rawToken);
    this.db
      .insert(apiToken)
      .values({
        user_id: userId,
        name,
        scope,
        token_hash: tokenHash,
        prefix: legacyTokenFingerprint(tokenHash),
        created_at: utcNow(),
      })
      .onConflictDoNothing({ target: [apiToken.token_hash, apiToken.scope] })
      .run();
    return this.db
      .select()
      .from(apiToken)
      .where(and(eq(apiToken.token_hash, tokenHash), eq(apiToken.scope, scope)))
      .get()!;
  }

  authenticateApiToken(rawToken: string, scope: string): { user: UserRow; tokenId: number } | undefined {
    if (!rawToken) return undefined;
    const token = this.db
      .select()
      .from(apiToken)
      .where(
        and(
          eq(apiToken.token_hash, hashToken(rawToken)),
          eq(apiToken.scope, scope),
          isNull(apiToken.revoked_at),
        ),
      )
      .get();
    if (!token) return undefined;
    if (token.expires_at !== null) {
      const expires = parseStoredTime(token.expires_at);
      if (!expires || expires.getTime() <= Date.now()) return undefined;
    }
    const u = this.db.select().from(user).where(eq(user.id, token.user_id)).get();
    if (!u || !u.enabled) return undefined;
    return { user: u, tokenId: token.id };
  }

  /** Update best-effort usage metadata. */
  touchApiToken(tokenId: number): void {
    this.db.update(apiToken).set({ last_used_at: utcNow() }).where(eq(apiToken.id, tokenId)).run();
  }

  revokeApiToken(tokenId: number): boolean {
    const result = this.db
      .update(apiToken)
      .set({ revoked_at: utcNow() })
      .where(and(eq(apiToken.id, tokenId), isNull(apiToken.revoked_at)))
      .run();
    return result.changes > 0;
  }

  passkeyBelongsToUser(userId: number, credentialId: string): boolean {
    const row = this.db
      .select({ id: passkey.id })
      .from(passkey)
      .where(and(eq(passkey.user_id, userId), eq(passkey.credential_id, credentialId)))
      .get();
    return row !== undefined;
  }

  listApiTokens(): ApiTokenRow[] {
    return this.db.select().from(apiToken).orderBy(desc(apiToken.created_at)).all();
  }

  /** Remove credentials before deleting their owning user. */
  purgeUserCredentials(userId: number): void {
    getSqlite().transaction(() => {
      this.db.delete(authSession).where(eq(authSession.user_id, userId)).run();
      this.db.delete(apiToken).where(eq(apiToken.user_id, userId)).run();
      this.db.delete(passkey).where(eq(passkey.user_id, userId)).run();
    })();
  }
}
