/**
 * Database engine singleton — mirrors module/database/engine.py.
 *
 * better-sqlite3 is synchronous; NestJS providers and plain function modules
 * share the same drizzle instance. PRAGMAs match the Python engine's
 * connection event listeners.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { DATA_PATH } from '../config/constants';
import { CREATE_TABLES_DDL, ENSURE_SCHEMA_VERSION_DDL } from './ddl';
import { runMigrations } from './migrations';
import * as schema from './schema';

const logger = new Logger('Database');

export type Db = BetterSQLite3Database<typeof schema>;

let sqlite: BetterSqlite3.Database | null = null;
let db: Db | null = null;

/** Open the database (idempotent). Applies PRAGMAs matching engine.py. */
export function getSqlite(): BetterSqlite3.Database {
  if (sqlite) return sqlite;
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  sqlite = new BetterSqlite3(DATA_PATH);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}

export function getDb(): Db {
  if (db) return db;
  db = drizzle(getSqlite(), { schema });
  return db;
}

/** create_tables_conn equivalent: model DDL + schema_version table. */
export function createTables(): void {
  const s = getSqlite();
  s.transaction(() => {
    for (const ddl of CREATE_TABLES_DDL) s.exec(ddl);
    s.exec(ENSURE_SCHEMA_VERSION_DDL);
  })();
  logger.debug('Tables ensured');
}

/** Full startup sequence: create tables (fresh) then run pending migrations. */
export function initDatabase(): void {
  createTables();
  runMigrations(getSqlite());
}

/** Test probe used by /health and Checker.check_database. */
export function checkDatabase(): boolean {
  try {
    getSqlite()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bangumi'")
      .get();
    return true;
  } catch {
    return false;
  }
}

export { schema };
