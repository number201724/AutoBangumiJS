/**
 * Database facade — mirrors module/database/combine.py.
 *
 * Python uses session-per-operation (`async with Database() as db`); with
 * better-sqlite3's synchronous single-writer model, one shared facade is
 * equivalent. `beginWrite()` mirrors the BEGIN IMMEDIATE write-transaction
 * guard used by the auth use-cases.
 */
import { Logger } from '@nestjs/common';

import { getDb, getSqlite } from './database';
import { Aria2GidDatabase } from './repos/aria2';
import { AuthDatabase } from './repos/auth';
import { BangumiDatabase } from './repos/bangumi';
import { InboxDatabase } from './repos/inbox';
import { LLMCredentialDatabase } from './repos/llm-credential';
import { MovieDatabase } from './repos/movie';
import { PasskeyDatabase } from './repos/passkey';
import { RenameOperationDatabase } from './repos/rename-operation';
import { RSSDatabase } from './repos/rss';
import { TorrentDatabase } from './repos/torrent';
import { UserDatabase } from './repos/user';

const logger = new Logger('Database');

export class Database {
  readonly rss = new RSSDatabase();
  readonly torrent = new TorrentDatabase();
  readonly bangumi = new BangumiDatabase();
  readonly movie = new MovieDatabase();
  readonly user = new UserDatabase();
  readonly aria2 = new Aria2GidDatabase();
  readonly auth = new AuthDatabase();
  readonly passkey = new PasskeyDatabase();
  readonly inbox = new InboxDatabase();
  readonly llm_credential = new LLMCredentialDatabase();
  readonly rename_operation = new RenameOperationDatabase();

  private inWriteTx = false;
  private currentWriteTx: Promise<void> = Promise.resolve();

  /**
   * Acquire the write transaction before invariant-checking reads.
   * Mirrors BEGIN IMMEDIATE on SQLite (serializes concurrent writers).
   */
  beginWrite(): void {
    if (this.inWriteTx) {
      throw new Error('Write transaction must begin before database access');
    }
    getSqlite().exec('BEGIN IMMEDIATE');
    this.inWriteTx = true;
  }

  commit(): void {
    if (this.inWriteTx) {
      getSqlite().exec('COMMIT');
      this.inWriteTx = false;
    }
  }

  rollback(): void {
    if (this.inWriteTx) {
      getSqlite().exec('ROLLBACK');
      this.inWriteTx = false;
    }
  }

  /** Run fn inside a BEGIN IMMEDIATE write transaction (commit/rollback). */
  inWriteTransaction<T>(fn: (db: Database) => T): T {
    this.beginWrite();
    try {
      const result = fn(this);
      this.commit();
      return result;
    } catch (e) {
      try {
        this.rollback();
      } catch (rollbackError) {
        logger.error(`Rollback failed: ${rollbackError}`);
      }
      throw e;
    }
  }

  /** Async variant for flows that await inside the transaction (WebAuthn).
   * 与 Python 的 busy_timeout 语义对齐：已有写事务在执行时**排队等待**其
   * 完成后再开始，而不是报错（周期任务之间可能交错）。 */
  async inWriteTransactionAsync<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const prev = this.currentWriteTx;
    let release!: () => void;
    this.currentWriteTx = new Promise((r) => (release = r));
    await prev;
    this.beginWrite();
    try {
      const result = await fn(this);
      this.commit();
      return result;
    } catch (e) {
      try {
        this.rollback();
      } catch (rollbackError) {
        logger.error(`Rollback failed: ${rollbackError}`);
      }
      throw e;
    } finally {
      release();
    }
  }

  /** Raw drizzle handle escape hatch (mirrors direct session usage). */
  get raw() {
    return getDb();
  }
}

/** Shared facade singleton (module-level, mirrors Python usage sites). */
export const db = new Database();
