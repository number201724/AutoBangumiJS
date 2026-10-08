/**
 * Authentication use cases — 1:1 port of module/application/auth.py.
 * (Ports/Protocols dissolve into the concrete Database facade; composition.ts
 * remains the single wiring point.)
 */
import { Logger } from '@nestjs/common';

import { db, type Database } from '../database/facade';
import type { ApiTokenRow, UserRow } from '../database/schema';
import { DEFAULT_SESSION_TTL_SECONDS } from '../database/repos/auth';

const logger = new Logger('AuthenticationService');

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export interface UserUpdateInput {
  username?: string | null;
  password?: string | null;
  enabled?: boolean | null;
}

export class AuthenticationService {
  constructor(private readonly databaseFactory: () => Database) {}

  private get db(): Database {
    return this.databaseFactory();
  }

  login(username: string, password: string): { user: UserRow; token: string } {
    return this.db.inWriteTransaction((d) => {
      const user = d.user.authenticateCredentials(username, password);
      if (!user) {
        throw new AuthenticationError('Invalid username or password');
      }
      return { user, token: d.auth.createSession(user.id) };
    });
  }

  authenticateSession(token: string): UserRow | undefined {
    return this.db.auth.authenticateSession(token);
  }

  authenticateApiToken(token: string, scope = 'api'): UserRow | undefined {
    const authenticated = this.db.auth.authenticateApiToken(token, scope);
    if (!authenticated) return undefined;
    try {
      this.db.auth.touchApiToken(authenticated.tokenId);
    } catch (e) {
      // last_used_at is audit metadata; a failed audit write must never turn
      // otherwise-valid authentication into a 500.
      logger.warn(`Failed to update API token usage: ${e}`);
    }
    return authenticated.user;
  }

  refreshSession(token: string, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS): UserRow | undefined {
    return this.db.inWriteTransaction((d) => d.auth.refreshSession(token, ttlSeconds));
  }

  logout(token: string): boolean {
    return this.db.inWriteTransaction((d) => d.auth.revokeSession(token));
  }

  issueSessionForVerifiedPasskey(userId: number, credentialId: string): string {
    return this.db.inWriteTransaction((d) => {
      const user = d.user.getUserById(userId);
      if (!user || !user.enabled || !d.auth.passkeyBelongsToUser(userId, credentialId)) {
        throw new AuthenticationError('User is not available');
      }
      return d.auth.createSession(userId);
    });
  }

  getUser(username: string): UserRow {
    const user = this.db.user.findUser(username);
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  listUsers(): UserRow[] {
    return this.db.user.listUsers();
  }

  createUser(data: { username: string; password: string }): UserRow {
    try {
      return this.db.user.createUser(data.username, data.password);
    } catch (e) {
      if (e instanceof Error && e.name === 'ValueError') {
        throw new ConflictError(e.message);
      }
      throw e;
    }
  }

  updateUser(userId: number, data: UserUpdateInput): UserRow {
    try {
      return this.db.inWriteTransaction((d) => {
        const user = d.user.updateUserById(userId, data);
        if (data.password || data.enabled === false) {
          d.auth.revokeUserSessions(userId);
        }
        return user;
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'ValueError') {
        if (e.message === 'User not found') throw new NotFoundError(e.message);
        throw new ConflictError(e.message);
      }
      throw e;
    }
  }

  updateCurrentUser(userId: number, data: UserUpdateInput): { user: UserRow; token: string } {
    if (data.enabled !== null && data.enabled !== undefined) {
      throw new ConflictError('Current-user update cannot change enabled state');
    }
    return this.db.inWriteTransaction((d) => {
      const current = d.user.getUserById(userId);
      if (!current) throw new NotFoundError('User not found');
      if (!current.enabled) throw new AuthenticationError('User is not available');
      let user: UserRow;
      try {
        user = d.user.updateUserById(userId, data);
      } catch (e) {
        if (e instanceof Error && e.name === 'ValueError') {
          throw new ConflictError(e.message);
        }
        throw e;
      }
      d.auth.revokeUserSessions(userId);
      const token = d.auth.createSession(userId);
      return { user, token };
    });
  }

  deleteUser(userId: number): void {
    try {
      this.db.inWriteTransaction((d) => {
        const user = d.user.getUserById(userId);
        if (!user) throw new NotFoundError('User not found');
        if (user.enabled && d.user.enabledCountPublic() <= 1) {
          throw new ConflictError('Cannot delete the last enabled user');
        }
        d.auth.purgeUserCredentials(userId);
        if (!d.user.deleteUser(userId)) {
          throw new NotFoundError('User not found');
        }
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'ValueError') {
        throw new ConflictError(e.message);
      }
      throw e;
    }
  }

  createApiTokenForUserId(
    userId: number,
    args: { name: string; scope: string; expiresAt?: string | null },
  ): { token: ApiTokenRow; rawToken: string } {
    return this.db.inWriteTransaction((d) => {
      const user = d.user.getUserById(userId);
      if (!user || !user.enabled) {
        throw new AuthenticationError('User is not available');
      }
      return d.auth.createApiToken(userId, args.name, args.scope, args.expiresAt ?? null);
    });
  }

  listApiTokens(): ApiTokenRow[] {
    return this.db.auth.listApiTokens();
  }

  revokeApiToken(tokenId: number): void {
    this.db.inWriteTransaction((d) => {
      if (!d.auth.revokeApiToken(tokenId)) {
        throw new NotFoundError('API token not found');
      }
    });
  }
}
