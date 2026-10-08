/**
 * Passkey repository — 1:1 port of module/database/passkey.py.
 */
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../database';
import { passkey } from '../schema';
import { toApiIso, utcNow } from '../../utils/time';

const logger = new Logger('PasskeyDatabase');

export type PasskeyRow = typeof passkey.$inferSelect;
export type NewPasskey = typeof passkey.$inferInsert;

export interface PasskeyListModel {
  id: number;
  name: string;
  created_at: string | null;
  last_used_at: string | null;
  backup_eligible: boolean | null;
  aaguid: string | null;
}

export class PasskeyDatabase {
  private get db() {
    return getDb();
  }

  createPasskey(data: NewPasskey): PasskeyRow {
    const result = this.db.insert(passkey).values(data).run();
    const id = Number(result.lastInsertRowid);
    logger.log(`Created passkey '${data.name}' for user_id=${data.user_id}`);
    return this.db.select().from(passkey).where(eq(passkey.id, id)).get()!;
  }

  getPasskeyByCredentialId(credentialId: string): PasskeyRow | undefined {
    return this.db
      .select()
      .from(passkey)
      .where(eq(passkey.credential_id, credentialId))
      .get();
  }

  getPasskeysByUserId(userId: number): PasskeyRow[] {
    return this.db.select().from(passkey).where(eq(passkey.user_id, userId)).all();
  }

  getPasskeyById(passkeyId: number, userId: number): PasskeyRow {
    const row = this.db
      .select()
      .from(passkey)
      .where(and(eq(passkey.id, passkeyId), eq(passkey.user_id, userId)))
      .get();
    if (!row) {
      throw new HttpException('Passkey not found', HttpStatus.NOT_FOUND);
    }
    return row;
  }

  /** 更新 Passkey 使用记录（签名计数器 + 最后使用时间） */
  updatePasskeyUsage(row: PasskeyRow, newSignCount: number): void {
    this.db
      .update(passkey)
      .set({ sign_count: newSignCount, last_used_at: utcNow() })
      .where(eq(passkey.id, row.id))
      .run();
  }

  deletePasskey(passkeyId: number, userId: number): boolean {
    const result = this.db
      .delete(passkey)
      .where(and(eq(passkey.id, passkeyId), eq(passkey.user_id, userId)))
      .run();
    if (!result.changes) {
      throw new HttpException('Passkey not found', HttpStatus.NOT_FOUND);
    }
    logger.log(`Deleted passkey id=${passkeyId} for user_id=${userId}`);
    return true;
  }

  /** 转换为安全的列表展示模型 */
  toListModel(row: PasskeyRow): PasskeyListModel {
    return {
      id: row.id,
      name: row.name,
      // pydantic datetime 序列化形态（'T' 分隔），与其他端点一致
      created_at: toApiIso(row.created_at),
      last_used_at: toApiIso(row.last_used_at),
      backup_eligible: row.backup_eligible,
      aaguid: row.aaguid,
    };
  }
}
