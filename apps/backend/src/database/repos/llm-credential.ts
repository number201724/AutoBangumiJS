/**
 * LLM credential repository — 1:1 port of module/database/llm_credential.py.
 * Read/write in TokenSet exchange format (extra is transparent JSON).
 */
import { count, eq } from 'drizzle-orm';
import { Logger } from '@nestjs/common';

import { getDb } from '../database';
import { llmcredential } from '../schema';
import { utcNowIso } from '../../utils/time';
import { emptyTokenSet, type TokenSet } from '../../parser/providers/base';

const logger = new Logger('LLMCredentialDatabase');

export class LLMCredentialDatabase {
  private get db() {
    return getDb();
  }

  private row(providerId: string) {
    return this.db
      .select()
      .from(llmcredential)
      .where(eq(llmcredential.provider_id, providerId))
      .get();
  }

  get(providerId: string): TokenSet | null {
    const row = this.row(providerId);
    if (!row) return null;
    let extra: Record<string, unknown> = {};
    if (row.extra) {
      try {
        extra = JSON.parse(row.extra) as Record<string, unknown>;
      } catch {
        logger.warn(`Corrupt credential extra for ${providerId}`);
      }
    }
    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expires_at: row.expires_at,
      account_label: row.account_label,
      extra,
    };
  }

  upsert(providerId: string, tokens: TokenSet): void {
    const existing = this.row(providerId);
    const values = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      account_label: tokens.account_label,
      extra: JSON.stringify(tokens.extra ?? {}),
      updated_at: utcNowIso(),
    };
    if (!existing) {
      this.db.insert(llmcredential).values({ provider_id: providerId, ...values }).run();
    } else {
      this.db
        .update(llmcredential)
        .set(values)
        .where(eq(llmcredential.provider_id, providerId))
        .run();
    }
  }

  delete(providerId: string): boolean {
    const existing = this.row(providerId);
    if (!existing) return false;
    this.db.delete(llmcredential).where(eq(llmcredential.provider_id, providerId)).run();
    return true;
  }

  count(): number {
    const row = this.db.select({ value: count() }).from(llmcredential).get();
    return row?.value ?? 0;
  }
}

export { emptyTokenSet };
