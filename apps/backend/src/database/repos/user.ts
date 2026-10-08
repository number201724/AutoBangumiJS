/**
 * User repository — 1:1 port of module/database/user.py.
 */
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';

import { getDb } from '../database';
import { user } from '../schema';
import { ValueError } from '../../common/errors';
import { getPasswordHash, verifyPassword } from '../../security/password';
import { utcNow } from '../../utils/time';

const logger = new Logger('UserDatabase');

export type UserRow = typeof user.$inferSelect;

export interface UserUpdateData {
  username?: string | null;
  password?: string | null;
  enabled?: boolean | null;
}

export interface AuthResponse {
  status: boolean;
  status_code: number;
  msg_en: string;
  msg_zh: string;
}


/** Python sqlalchemy.IntegrityError 的 better-sqlite3 对应：唯一约束冲突才转换，
 * 其它 DB 错误（SQLITE_BUSY/磁盘满等）必须原样抛出。 */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export class UserDatabase {
  private get db() {
    return getDb();
  }

  getUser(username: string): UserRow {
    const row = this.db.select().from(user).where(eq(user.username, username)).get();
    if (!row) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }
    return row;
  }

  findUser(username: string): UserRow | undefined {
    return this.db.select().from(user).where(eq(user.username, username)).get();
  }

  authenticateCredentials(username: string, password: string): UserRow | undefined {
    const row = this.findUser(username);
    if (!row || !row.enabled || !verifyPassword(password, row.password)) {
      return undefined;
    }
    return row;
  }

  getUserById(userId: number): UserRow | undefined {
    return this.db.select().from(user).where(eq(user.id, userId)).get();
  }

  listUsers(): UserRow[] {
    return this.db.select().from(user).orderBy(asc(user.username)).all();
  }

  createUser(username: string, password: string): UserRow {
    const now = utcNow();
    try {
      const result = this.db
        .insert(user)
        .values({ username, password: getPasswordHash(password), enabled: true, created_at: now, updated_at: now })
        .run();
      return this.getUserById(Number(result.lastInsertRowid))!;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      throw new ValueError('Username already exists', { cause: e });
    }
  }

  private enabledCount(): number {
    const row = this.db
      .select({ value: count() })
      .from(user)
      .where(eq(user.enabled, true))
      .get();
    return row?.value ?? 0;
  }

  enabledCountPublic(): number {
    return this.enabledCount();
  }

  updateUserById(userId: number, data: UserUpdateData): UserRow {
    const row = this.getUserById(userId);
    if (!row) throw new ValueError('User not found');
    if (data.enabled === false && row.enabled && this.enabledCount() <= 1) {
      throw new ValueError('Cannot disable the last enabled user');
    }
    const fields: Partial<typeof user.$inferInsert> = {};
    if (data.username !== null && data.username !== undefined && data.username !== row.username) {
      if (this.findUser(data.username) !== undefined) {
        throw new ValueError('Username already exists');
      }
      fields.username = data.username;
    }
    if (data.password !== null && data.password !== undefined) {
      fields.password = getPasswordHash(data.password);
    }
    if (data.enabled !== null && data.enabled !== undefined) {
      fields.enabled = data.enabled;
    }
    fields.updated_at = utcNow();
    try {
      this.db.update(user).set(fields).where(eq(user.id, userId)).run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      throw new ValueError('Username already exists', { cause: e });
    }
    return this.getUserById(userId)!;
  }

  setEnabled(userId: number, enabled: boolean): UserRow {
    return this.updateUserById(userId, { enabled });
  }

  deleteUser(userId: number): boolean {
    const row = this.getUserById(userId);
    if (!row) return false;
    if (row.enabled && this.enabledCount() <= 1) {
      throw new ValueError('Cannot delete the last enabled user');
    }
    this.db.delete(user).where(eq(user.id, userId)).run();
    return true;
  }

  /** Verify credentials; mirrors UserDatabase.auth_user ResponseModel flow. */
  authUser(username: string, password: string | undefined): AuthResponse {
    const dbUser = this.findUser(username);
    if (!password) {
      return { status_code: 401, status: false, msg_en: 'Incorrect password format', msg_zh: '密码格式不正确' };
    }
    if (!dbUser || !dbUser.enabled) {
      return { status_code: 401, status: false, msg_en: 'User not found', msg_zh: '用户不存在' };
    }
    if (!verifyPassword(password, dbUser.password)) {
      return { status_code: 401, status: false, msg_en: 'Incorrect password', msg_zh: '密码错误' };
    }
    return { status_code: 200, status: true, msg_en: 'Login successfully', msg_zh: '登录成功' };
  }

  updateUser(username: string, updateData: UserUpdateData): UserRow {
    const dbUser = this.findUser(username);
    if (!dbUser) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }
    return this.updateUserById(dbUser.id, updateData);
  }

  addDefaultUser(): void {
    let users: UserRow[];
    try {
      users = this.db.select().from(user).all();
    } catch (e) {
      // Table may not exist yet during initial setup
      logger.debug(`Could not query users table (may not exist yet): ${e}`);
      users = [];
    }
    if (users.length !== 0) return;
    const now = utcNow();
    this.db
      .insert(user)
      .values({ username: 'admin', password: getPasswordHash('adminadmin'), enabled: true, created_at: now, updated_at: now })
      .run();
    logger.log('Created default admin user');
  }
}
