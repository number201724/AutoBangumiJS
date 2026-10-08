/**
 * Table-driven schema migrations — 1:1 port of module/database/migrations.py.
 *
 * Each migration carries an `alreadyApplied` guard (or per-statement
 * `guardedStatements`) so a database created by CREATE TABLES DDL skips them
 * all, while old databases upgrade in order. Runs inside one transaction with
 * a SAVEPOINT per migration; any failure rolls back and aborts startup.
 */
import { Logger } from '@nestjs/common';
import type BetterSqlite3 from 'better-sqlite3';

const logger = new Logger('Migration');

type Database = BetterSqlite3.Database;

// ---------------------------------------------------------------------------
// Inspector helpers (mirror sqlalchemy inspect())
// ---------------------------------------------------------------------------

interface Inspector {
  tableNames(): string[];
  columnNames(table: string): string[];
  indexNames(table: string): string[];
}

function inspect(db: Database): Inspector {
  return {
    tableNames(): string[] {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      return rows.map((r) => r.name);
    },
    columnNames(table: string): string[] {
      const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
        name: string;
      }[];
      return rows.map((r) => r.name);
    },
    indexNames(table: string): string[] {
      const rows = db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all() as {
        name: string;
      }[];
      return rows.map((r) => r.name);
    },
  };
}

type AppliedCheck = (insp: Inspector) => boolean;
type GuardedStatement = [string, AppliedCheck];

function columnExists(table: string, column: string): AppliedCheck {
  return (insp) =>
    insp.tableNames().includes(table) && insp.columnNames(table).includes(column);
}

function tableExists(table: string): AppliedCheck {
  return (insp) => insp.tableNames().includes(table);
}

function indexExists(table: string, index: string): AppliedCheck {
  return (insp) =>
    insp.tableNames().includes(table) && insp.indexNames(table).includes(index);
}

function allChecks(...checks: AppliedCheck[]): AppliedCheck {
  return (insp) => checks.every((c) => c(insp));
}

interface Migration {
  version: number;
  description: string;
  statements: string[];
  alreadyApplied: AppliedCheck;
  guardedStatements?: GuardedStatement[];
}

function pendingStatements(m: Migration, insp: Inspector): string[] {
  if (m.guardedStatements) {
    return m.guardedStatements
      .filter(([, applied]) => !applied(insp))
      .map(([stmt]) => stmt);
  }
  if (m.alreadyApplied(insp)) return [];
  return m.statements;
}

// ---------------------------------------------------------------------------
// Migrations (version numbers match the Python 3.2.x history)
// ---------------------------------------------------------------------------

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'add air_weekday column to bangumi',
    statements: ['ALTER TABLE bangumi ADD COLUMN air_weekday INTEGER'],
    alreadyApplied: columnExists('bangumi', 'air_weekday'),
  },
  {
    version: 2,
    description: 'add connection status columns to rssitem',
    statements: [
      'ALTER TABLE rssitem ADD COLUMN connection_status TEXT',
      'ALTER TABLE rssitem ADD COLUMN last_checked_at TEXT',
      'ALTER TABLE rssitem ADD COLUMN last_error TEXT',
    ],
    alreadyApplied: allChecks(
      columnExists('rssitem', 'connection_status'),
      columnExists('rssitem', 'last_checked_at'),
      columnExists('rssitem', 'last_error'),
    ),
    guardedStatements: [
      [
        'ALTER TABLE rssitem ADD COLUMN connection_status TEXT',
        columnExists('rssitem', 'connection_status'),
      ],
      ['ALTER TABLE rssitem ADD COLUMN last_checked_at TEXT', columnExists('rssitem', 'last_checked_at')],
      ['ALTER TABLE rssitem ADD COLUMN last_error TEXT', columnExists('rssitem', 'last_error')],
    ],
  },
  {
    version: 3,
    description: 'create passkey table for WebAuthn support',
    statements: [
      `CREATE TABLE IF NOT EXISTS passkey (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES user(id),
        name VARCHAR(64) NOT NULL,
        credential_id VARCHAR NOT NULL UNIQUE,
        public_key VARCHAR NOT NULL,
        sign_count INTEGER DEFAULT 0,
        aaguid VARCHAR,
        transports VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        backup_eligible BOOLEAN DEFAULT 0,
        backup_state BOOLEAN DEFAULT 0
      )`,
      'CREATE INDEX IF NOT EXISTS ix_passkey_user_id ON passkey(user_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS ix_passkey_credential_id ON passkey(credential_id)',
    ],
    alreadyApplied: tableExists('passkey'),
  },
  {
    version: 4,
    description: 'add archived column to bangumi',
    statements: ['ALTER TABLE bangumi ADD COLUMN archived BOOLEAN DEFAULT 0'],
    alreadyApplied: columnExists('bangumi', 'archived'),
  },
  {
    version: 5,
    description: 'rename offset to episode_offset, add season_offset and review fields',
    statements: [
      'ALTER TABLE bangumi RENAME COLUMN offset TO episode_offset',
      'ALTER TABLE bangumi ADD COLUMN season_offset INTEGER DEFAULT 0',
      'ALTER TABLE bangumi ADD COLUMN needs_review INTEGER DEFAULT 0',
      'ALTER TABLE bangumi ADD COLUMN needs_review_reason TEXT DEFAULT NULL',
    ],
    alreadyApplied: allChecks(
      columnExists('bangumi', 'episode_offset'),
      columnExists('bangumi', 'season_offset'),
      columnExists('bangumi', 'needs_review'),
      columnExists('bangumi', 'needs_review_reason'),
    ),
    guardedStatements: [
      [
        'ALTER TABLE bangumi RENAME COLUMN offset TO episode_offset',
        columnExists('bangumi', 'episode_offset'),
      ],
      [
        'ALTER TABLE bangumi ADD COLUMN season_offset INTEGER DEFAULT 0',
        columnExists('bangumi', 'season_offset'),
      ],
      [
        'ALTER TABLE bangumi ADD COLUMN needs_review INTEGER DEFAULT 0',
        columnExists('bangumi', 'needs_review'),
      ],
      [
        'ALTER TABLE bangumi ADD COLUMN needs_review_reason TEXT DEFAULT NULL',
        columnExists('bangumi', 'needs_review_reason'),
      ],
    ],
  },
  {
    version: 6,
    description: 'add qb_hash column to torrent for downloader tracking',
    statements: [
      'ALTER TABLE torrent ADD COLUMN qb_hash TEXT',
      'CREATE INDEX IF NOT EXISTS ix_torrent_qb_hash ON torrent(qb_hash)',
    ],
    alreadyApplied: allChecks(
      columnExists('torrent', 'qb_hash'),
      indexExists('torrent', 'ix_torrent_qb_hash'),
    ),
    guardedStatements: [
      ['ALTER TABLE torrent ADD COLUMN qb_hash TEXT', columnExists('torrent', 'qb_hash')],
      [
        'CREATE INDEX IF NOT EXISTS ix_torrent_qb_hash ON torrent(qb_hash)',
        indexExists('torrent', 'ix_torrent_qb_hash'),
      ],
    ],
  },
  {
    version: 7,
    description: 'add suggested offset columns for offset review',
    statements: [
      'ALTER TABLE bangumi ADD COLUMN suggested_season_offset INTEGER DEFAULT NULL',
      'ALTER TABLE bangumi ADD COLUMN suggested_episode_offset INTEGER DEFAULT NULL',
    ],
    alreadyApplied: allChecks(
      columnExists('bangumi', 'suggested_season_offset'),
      columnExists('bangumi', 'suggested_episode_offset'),
    ),
    guardedStatements: [
      [
        'ALTER TABLE bangumi ADD COLUMN suggested_season_offset INTEGER DEFAULT NULL',
        columnExists('bangumi', 'suggested_season_offset'),
      ],
      [
        'ALTER TABLE bangumi ADD COLUMN suggested_episode_offset INTEGER DEFAULT NULL',
        columnExists('bangumi', 'suggested_episode_offset'),
      ],
    ],
  },
  {
    version: 8,
    description: 'add title_aliases for mid-season naming changes',
    statements: ['ALTER TABLE bangumi ADD COLUMN title_aliases TEXT DEFAULT NULL'],
    alreadyApplied: columnExists('bangumi', 'title_aliases'),
  },
  {
    version: 9,
    description: 'add weekday_locked column to bangumi',
    statements: ['ALTER TABLE bangumi ADD COLUMN weekday_locked BOOLEAN DEFAULT 0'],
    alreadyApplied: columnExists('bangumi', 'weekday_locked'),
  },
  {
    version: 10,
    description: 'add preferred_group and preferred_resolution columns to bangumi',
    statements: [
      'ALTER TABLE bangumi ADD COLUMN preferred_group TEXT DEFAULT NULL',
      'ALTER TABLE bangumi ADD COLUMN preferred_resolution TEXT DEFAULT NULL',
    ],
    alreadyApplied: allChecks(
      columnExists('bangumi', 'preferred_group'),
      columnExists('bangumi', 'preferred_resolution'),
    ),
    guardedStatements: [
      [
        'ALTER TABLE bangumi ADD COLUMN preferred_group TEXT DEFAULT NULL',
        columnExists('bangumi', 'preferred_group'),
      ],
      [
        'ALTER TABLE bangumi ADD COLUMN preferred_resolution TEXT DEFAULT NULL',
        columnExists('bangumi', 'preferred_resolution'),
      ],
    ],
  },
  {
    version: 11,
    description: 'create aria2_gid table for aria2 gid<->bangumi association',
    statements: [
      `CREATE TABLE IF NOT EXISTS aria2_gid (
        gid VARCHAR NOT NULL PRIMARY KEY,
        bangumi_id INTEGER REFERENCES bangumi(id),
        category VARCHAR,
        dedup_key VARCHAR,
        created_at TIMESTAMP NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS ix_aria2_gid_dedup_key ON aria2_gid(dedup_key)',
    ],
    alreadyApplied: tableExists('aria2_gid'),
  },
  {
    version: 12,
    description: 'add episode_type column to bangumi for movie/special support',
    statements: [`ALTER TABLE bangumi ADD COLUMN episode_type TEXT DEFAULT 'episode'`],
    alreadyApplied: columnExists('bangumi', 'episode_type'),
  },
  {
    version: 13,
    description:
      'backfill indexes on bangumi/rssitem/torrent for pre-existing databases',
    statements: [
      'CREATE INDEX IF NOT EXISTS ix_bangumi_title_raw ON bangumi(title_raw)',
      'CREATE INDEX IF NOT EXISTS ix_bangumi_deleted ON bangumi(deleted)',
      'CREATE INDEX IF NOT EXISTS ix_bangumi_archived ON bangumi(archived)',
      'CREATE INDEX IF NOT EXISTS ix_rssitem_url ON rssitem(url)',
      'CREATE INDEX IF NOT EXISTS ix_torrent_rss_id ON torrent(rss_id)',
      'CREATE INDEX IF NOT EXISTS ix_torrent_url ON torrent(url)',
    ],
    alreadyApplied: (insp) =>
      [
        indexExists('bangumi', 'ix_bangumi_title_raw'),
        indexExists('bangumi', 'ix_bangumi_deleted'),
        indexExists('bangumi', 'ix_bangumi_archived'),
        indexExists('rssitem', 'ix_rssitem_url'),
        indexExists('torrent', 'ix_torrent_rss_id'),
        indexExists('torrent', 'ix_torrent_url'),
      ].every((c) => c(insp)),
  },
  {
    version: 14,
    description: 'add index on torrent.bangumi_id',
    statements: ['CREATE INDEX IF NOT EXISTS ix_torrent_bangumi_id ON torrent(bangumi_id)'],
    alreadyApplied: indexExists('torrent', 'ix_torrent_bangumi_id'),
  },
  {
    version: 15,
    description: 'add renamed_paths column to aria2_gid for persisted file renames',
    statements: ['ALTER TABLE aria2_gid ADD COLUMN renamed_paths TEXT DEFAULT NULL'],
    alreadyApplied: columnExists('aria2_gid', 'renamed_paths'),
  },
  {
    version: 16,
    description: 'create inboxmessage table for the in-app notification center',
    statements: [
      `CREATE TABLE IF NOT EXISTS inboxmessage (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT '',
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        payload TEXT,
        dedup_key TEXT,
        read BOOLEAN NOT NULL DEFAULT 0,
        count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      )`,
      'CREATE INDEX IF NOT EXISTS ix_inboxmessage_kind ON inboxmessage(kind)',
      'CREATE INDEX IF NOT EXISTS ix_inboxmessage_dedup_key ON inboxmessage(dedup_key)',
      'CREATE INDEX IF NOT EXISTS ix_inboxmessage_read ON inboxmessage(read)',
    ],
    alreadyApplied: tableExists('inboxmessage'),
  },
  {
    version: 17,
    description: 'create llmcredential table for subscription LLM provider tokens',
    statements: [
      `CREATE TABLE IF NOT EXISTS llmcredential (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL DEFAULT '',
        access_token TEXT NOT NULL DEFAULT '',
        refresh_token TEXT NOT NULL DEFAULT '',
        expires_at REAL,
        account_label TEXT NOT NULL DEFAULT '',
        extra TEXT,
        updated_at TEXT NOT NULL DEFAULT ''
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS ix_llmcredential_provider_id ON llmcredential(provider_id)',
    ],
    alreadyApplied: tableExists('llmcredential'),
  },
  {
    version: 18,
    description: 'add multi-user account state and audit columns',
    statements: [
      'ALTER TABLE user ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 1',
      `ALTER TABLE user ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00'`,
      `ALTER TABLE user ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00'`,
      'CREATE UNIQUE INDEX IF NOT EXISTS ix_user_username ON user(username)',
      'CREATE INDEX IF NOT EXISTS ix_user_enabled ON user(enabled)',
    ],
    alreadyApplied: allChecks(
      columnExists('user', 'enabled'),
      columnExists('user', 'created_at'),
      columnExists('user', 'updated_at'),
      indexExists('user', 'ix_user_username'),
      indexExists('user', 'ix_user_enabled'),
    ),
    guardedStatements: [
      [
        'ALTER TABLE user ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 1',
        columnExists('user', 'enabled'),
      ],
      [
        `ALTER TABLE user ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00'`,
        columnExists('user', 'created_at'),
      ],
      [
        `ALTER TABLE user ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00'`,
        columnExists('user', 'updated_at'),
      ],
      [
        'CREATE UNIQUE INDEX IF NOT EXISTS ix_user_username ON user(username)',
        indexExists('user', 'ix_user_username'),
      ],
      [
        'CREATE INDEX IF NOT EXISTS ix_user_enabled ON user(enabled)',
        indexExists('user', 'ix_user_enabled'),
      ],
    ],
  },
  {
    version: 19,
    description: 'create persistent sessions and scoped API tokens',
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_session (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES user(id),
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        created_at TIMESTAMP NOT NULL,
        last_seen_at TIMESTAMP NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS ix_auth_session_user_id ON auth_session(user_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS ix_auth_session_token_hash ON auth_session(token_hash)',
      'CREATE INDEX IF NOT EXISTS ix_auth_session_expires_at ON auth_session(expires_at)',
      'CREATE INDEX IF NOT EXISTS ix_auth_session_revoked_at ON auth_session(revoked_at)',
      `CREATE TABLE IF NOT EXISTS api_token (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES user(id),
        name VARCHAR(64) NOT NULL,
        scope VARCHAR(8) NOT NULL,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        prefix VARCHAR(16) NOT NULL,
        created_at TIMESTAMP NOT NULL,
        last_used_at TIMESTAMP,
        expires_at TIMESTAMP,
        revoked_at TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS ix_api_token_user_id ON api_token(user_id)',
      'CREATE INDEX IF NOT EXISTS ix_api_token_scope ON api_token(scope)',
      'CREATE UNIQUE INDEX IF NOT EXISTS ix_api_token_token_hash ON api_token(token_hash)',
      'CREATE INDEX IF NOT EXISTS ix_api_token_expires_at ON api_token(expires_at)',
      'CREATE INDEX IF NOT EXISTS ix_api_token_revoked_at ON api_token(revoked_at)',
    ],
    alreadyApplied: allChecks(tableExists('auth_session'), tableExists('api_token')),
  },
  {
    version: 20,
    description: 'make API token identity scope-aware and redact stored display prefixes',
    statements: [
      `CREATE TABLE api_token_v20 (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES user(id),
        name VARCHAR(64) NOT NULL,
        scope VARCHAR(8) NOT NULL,
        token_hash VARCHAR(64) NOT NULL,
        prefix VARCHAR(16) NOT NULL,
        created_at TIMESTAMP NOT NULL,
        last_used_at TIMESTAMP,
        expires_at TIMESTAMP,
        revoked_at TIMESTAMP
      )`,
      `INSERT INTO api_token_v20 (
        id, user_id, name, scope, token_hash, prefix, created_at,
        last_used_at, expires_at, revoked_at
      ) SELECT
        id, user_id, name, scope, token_hash,
        'legacy_' || substr(token_hash, 1, 8), created_at,
        last_used_at, expires_at, revoked_at
      FROM api_token`,
      'DROP TABLE api_token',
      'ALTER TABLE api_token_v20 RENAME TO api_token',
      'CREATE INDEX ix_api_token_user_id ON api_token(user_id)',
      'CREATE INDEX ix_api_token_scope ON api_token(scope)',
      'CREATE UNIQUE INDEX ix_api_token_token_hash_scope ON api_token(token_hash, scope)',
      'CREATE INDEX ix_api_token_expires_at ON api_token(expires_at)',
      'CREATE INDEX ix_api_token_revoked_at ON api_token(revoked_at)',
    ],
    // schema_version gate makes this one-time; every db below v20 must rebuild.
    alreadyApplied: () => false,
  },
  {
    version: 21,
    description: 'create movie table for standalone movie subscriptions',
    statements: [
      `CREATE TABLE IF NOT EXISTS movie (
        id INTEGER PRIMARY KEY,
        official_title VARCHAR NOT NULL,
        title_raw VARCHAR,
        year INTEGER,
        group_name VARCHAR,
        dpi VARCHAR,
        source VARCHAR,
        subtitle VARCHAR,
        poster_link VARCHAR,
        rss_link VARCHAR,
        added BOOLEAN NOT NULL DEFAULT 0,
        deleted BOOLEAN NOT NULL DEFAULT 0,
        save_path VARCHAR,
        rule_name VARCHAR,
        filter VARCHAR NOT NULL DEFAULT ''
      )`,
      'CREATE INDEX IF NOT EXISTS ix_movie_title_raw ON movie(title_raw)',
      'CREATE INDEX IF NOT EXISTS ix_movie_deleted ON movie(deleted)',
    ],
    alreadyApplied: allChecks(
      tableExists('movie'),
      indexExists('movie', 'ix_movie_title_raw'),
      indexExists('movie', 'ix_movie_deleted'),
    ),
    guardedStatements: [
      [
        `CREATE TABLE IF NOT EXISTS movie (
          id INTEGER PRIMARY KEY,
          official_title VARCHAR NOT NULL,
          title_raw VARCHAR,
          year INTEGER,
          group_name VARCHAR,
          dpi VARCHAR,
          source VARCHAR,
          subtitle VARCHAR,
          poster_link VARCHAR,
          rss_link VARCHAR,
          added BOOLEAN NOT NULL DEFAULT 0,
          deleted BOOLEAN NOT NULL DEFAULT 0,
          save_path VARCHAR,
          rule_name VARCHAR,
          filter VARCHAR NOT NULL DEFAULT ''
        )`,
        tableExists('movie'),
      ],
      [
        'CREATE INDEX IF NOT EXISTS ix_movie_title_raw ON movie(title_raw)',
        indexExists('movie', 'ix_movie_title_raw'),
      ],
      [
        'CREATE INDEX IF NOT EXISTS ix_movie_deleted ON movie(deleted)',
        indexExists('movie', 'ix_movie_deleted'),
      ],
    ],
  },
  {
    version: 22,
    description: 'repair multi-user v18 fields after the divergent movie development schema',
    statements: [
      'ALTER TABLE user ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 1',
      `ALTER TABLE user ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00'`,
      `ALTER TABLE user ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00'`,
      'CREATE UNIQUE INDEX IF NOT EXISTS ix_user_username ON user(username)',
      'CREATE INDEX IF NOT EXISTS ix_user_enabled ON user(enabled)',
    ],
    alreadyApplied: allChecks(
      columnExists('user', 'enabled'),
      columnExists('user', 'created_at'),
      columnExists('user', 'updated_at'),
      indexExists('user', 'ix_user_username'),
      indexExists('user', 'ix_user_enabled'),
    ),
    guardedStatements: [
      [
        'ALTER TABLE user ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 1',
        columnExists('user', 'enabled'),
      ],
      [
        `ALTER TABLE user ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00'`,
        columnExists('user', 'created_at'),
      ],
      [
        `ALTER TABLE user ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00'`,
        columnExists('user', 'updated_at'),
      ],
      [
        'CREATE UNIQUE INDEX IF NOT EXISTS ix_user_username ON user(username)',
        indexExists('user', 'ix_user_username'),
      ],
      [
        'CREATE INDEX IF NOT EXISTS ix_user_enabled ON user(enabled)',
        indexExists('user', 'ix_user_enabled'),
      ],
    ],
  },
  {
    version: 23,
    description: 'create durable rename/revision-replacement operation state',
    statements: [
      `CREATE TABLE IF NOT EXISTS rename_operation (
        id INTEGER PRIMARY KEY,
        downloader_type VARCHAR(32) NOT NULL,
        kind VARCHAR(32) NOT NULL DEFAULT 'conflict',
        state VARCHAR(32) NOT NULL DEFAULT 'planned',
        new_task_id VARCHAR NOT NULL,
        old_task_id VARCHAR,
        save_path VARCHAR NOT NULL,
        source_path VARCHAR NOT NULL,
        target_path VARCHAR NOT NULL,
        staged_path VARCHAR,
        bangumi_id INTEGER,
        media_type VARCHAR(32),
        season INTEGER,
        episode REAL,
        group_name VARCHAR,
        resolution VARCHAR(32),
        old_revision INTEGER,
        new_revision INTEGER,
        revision_metadata TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        retry_at TIMESTAMP,
        lease_owner VARCHAR(64),
        lease_expires_at TIMESTAMP,
        notified_at TIMESTAMP,
        last_error TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT ck_rename_operation_state CHECK (
          state IN ('conflict', 'retry', 'running', 'planned', 'old_staged',
                    'new_promoted', 'old_removed', 'done')
        ),
        CONSTRAINT ck_rename_operation_attempt_count CHECK (attempt_count >= 0)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_rename_operation_identity
       ON rename_operation(downloader_type, new_task_id, save_path, source_path, target_path)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_rename_operation_active_target
       ON rename_operation(downloader_type, save_path, target_path) WHERE state NOT IN ('done')`,
      'CREATE INDEX IF NOT EXISTS ix_rename_operation_state_retry_at ON rename_operation(state, retry_at)',
      'CREATE INDEX IF NOT EXISTS ix_rename_operation_new_task_id ON rename_operation(new_task_id)',
      'CREATE INDEX IF NOT EXISTS ix_rename_operation_old_task_id ON rename_operation(old_task_id)',
    ],
    alreadyApplied: allChecks(
      tableExists('rename_operation'),
      indexExists('rename_operation', 'ux_rename_operation_identity'),
      indexExists('rename_operation', 'ux_rename_operation_active_target'),
      indexExists('rename_operation', 'ix_rename_operation_state_retry_at'),
      indexExists('rename_operation', 'ix_rename_operation_new_task_id'),
      indexExists('rename_operation', 'ix_rename_operation_old_task_id'),
    ),
    guardedStatements: [
      [
        `CREATE TABLE IF NOT EXISTS rename_operation (
          id INTEGER PRIMARY KEY,
          downloader_type VARCHAR(32) NOT NULL,
          kind VARCHAR(32) NOT NULL DEFAULT 'conflict',
          state VARCHAR(32) NOT NULL DEFAULT 'planned',
          new_task_id VARCHAR NOT NULL,
          old_task_id VARCHAR,
          save_path VARCHAR NOT NULL,
          source_path VARCHAR NOT NULL,
          target_path VARCHAR NOT NULL,
          staged_path VARCHAR,
          bangumi_id INTEGER,
          media_type VARCHAR(32),
          season INTEGER,
          episode REAL,
          group_name VARCHAR,
          resolution VARCHAR(32),
          old_revision INTEGER,
          new_revision INTEGER,
          revision_metadata TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          retry_at TIMESTAMP,
          lease_owner VARCHAR(64),
          lease_expires_at TIMESTAMP,
          notified_at TIMESTAMP,
          last_error TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT ck_rename_operation_state CHECK (
            state IN ('conflict', 'retry', 'running', 'planned', 'old_staged',
                      'new_promoted', 'old_removed', 'done')
          ),
          CONSTRAINT ck_rename_operation_attempt_count CHECK (attempt_count >= 0)
        )`,
        tableExists('rename_operation'),
      ],
      [
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_rename_operation_identity
         ON rename_operation(downloader_type, new_task_id, save_path, source_path, target_path)`,
        indexExists('rename_operation', 'ux_rename_operation_identity'),
      ],
      [
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_rename_operation_active_target
         ON rename_operation(downloader_type, save_path, target_path) WHERE state NOT IN ('done')`,
        indexExists('rename_operation', 'ux_rename_operation_active_target'),
      ],
      [
        'CREATE INDEX IF NOT EXISTS ix_rename_operation_state_retry_at ON rename_operation(state, retry_at)',
        indexExists('rename_operation', 'ix_rename_operation_state_retry_at'),
      ],
      [
        'CREATE INDEX IF NOT EXISTS ix_rename_operation_new_task_id ON rename_operation(new_task_id)',
        indexExists('rename_operation', 'ix_rename_operation_new_task_id'),
      ],
      [
        'CREATE INDEX IF NOT EXISTS ix_rename_operation_old_task_id ON rename_operation(old_task_id)',
        indexExists('rename_operation', 'ix_rename_operation_old_task_id'),
      ],
    ],
  },
  {
    version: 24,
    description: 'add durable filesystem rename intent to aria2 gid state',
    statements: [
      `CREATE TABLE IF NOT EXISTS aria2_gid (
        gid VARCHAR NOT NULL PRIMARY KEY,
        bangumi_id INTEGER REFERENCES bangumi(id),
        category VARCHAR,
        dedup_key VARCHAR,
        renamed_paths TEXT DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      'ALTER TABLE aria2_gid ADD COLUMN rename_intent TEXT DEFAULT NULL',
    ],
    alreadyApplied: columnExists('aria2_gid', 'rename_intent'),
    guardedStatements: [
      [
        `CREATE TABLE IF NOT EXISTS aria2_gid (
          gid VARCHAR NOT NULL PRIMARY KEY,
          bangumi_id INTEGER REFERENCES bangumi(id),
          category VARCHAR,
          dedup_key VARCHAR,
          renamed_paths TEXT DEFAULT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        tableExists('aria2_gid'),
      ],
      [
        'ALTER TABLE aria2_gid ADD COLUMN rename_intent TEXT DEFAULT NULL',
        columnExists('aria2_gid', 'rename_intent'),
      ],
    ],
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// ---------------------------------------------------------------------------
// schema_version helpers
// ---------------------------------------------------------------------------

function ensureSchemaVersionTable(db: Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)',
  );
}

function getSchemaVersion(db: Database): number {
  if (!inspect(db).tableNames().includes('schema_version')) return 0;
  const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as
    | { version: number }
    | undefined;
  return row ? row.version : 0;
}

function setSchemaVersion(db: Database, version: number): void {
  db.prepare('INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)').run(version);
}

// ---------------------------------------------------------------------------
// fill_null_with_defaults (static port of the model-default introspection)
// ---------------------------------------------------------------------------

/**
 * Non-optional model fields with concrete (non-None, non-factory) defaults.
 * Booleans are stored as 1/0. Mirrors fill_null_with_defaults_conn.
 */
const TABLE_DEFAULTS: Record<string, Record<string, string | number>> = {
  bangumi: {
    official_title: 'official_title',
    title_raw: 'title_raw',
    season: 1,
    eps_collect: 0,
    episode_offset: 0,
    season_offset: 0,
    filter: '720,\\d+-\\d+',
    rss_link: '',
    added: 0,
    deleted: 0,
    archived: 0,
    weekday_locked: 0,
    needs_review: 0,
    episode_type: 'episode',
  },
  movie: { official_title: 'official_title', added: 0, deleted: 0, filter: '' },
  rssitem: { url: 'https://mikanani.me', aggregate: 0, parser: 'mikan', enabled: 1 },
  torrent: { name: '', url: 'https://example.com/torrent', downloaded: 0 },
  user: { username: 'admin', password: '', enabled: 1 },
  passkey: { sign_count: 0, backup_eligible: 0, backup_state: 0 },
  inboxmessage: { kind: '', severity: 'info', title: '', body: '', read: 0, count: 1 },
  llmcredential: { provider_id: '', access_token: '', refresh_token: '', account_label: '' },
  rename_operation: { kind: 'conflict', state: 'planned', attempt_count: 0 },
};

function fillNullWithDefaults(db: Database): void {
  const insp = inspect(db);
  const tables = insp.tableNames();
  for (const [table, defaults] of Object.entries(TABLE_DEFAULTS)) {
    if (!tables.includes(table)) continue;
    const dbColumns = insp.columnNames(table);
    for (const [column, value] of Object.entries(defaults)) {
      if (!dbColumns.includes(column)) continue;
      const result = db
        .prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" IS NULL`)
        .run(value);
      if (result.changes > 0) {
        logger.log(
          `Filled ${result.changes} NULL values in ${table}.${column} with default: ${value}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Execute all pending migrations in a single transaction; SAVEPOINT per
 * migration, failure rolls back and rethrows (startup aborts loudly).
 */
export function runMigrations(db: Database): void {
  db.transaction(() => {
    ensureSchemaVersionTable(db);
    const current = getSchemaVersion(db);
    if (current >= CURRENT_SCHEMA_VERSION) return;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      // 每轮重新 inspect：前一个迁移的 DDL 需要对守卫可见
      const pending = pendingStatements(migration, inspect(db));
      if (pending.length === 0) {
        logger.debug(
          `Migration v${migration.version} skipped (already applied): ${migration.description}`,
        );
      } else {
        const sp = `migration_v${migration.version}`;
        db.exec(`SAVEPOINT ${sp}`);
        try {
          for (const stmt of pending) {
            db.exec(stmt);
          }
          db.exec(`RELEASE SAVEPOINT ${sp}`);
          logger.log(`Migration v${migration.version}: ${migration.description}`);
        } catch (e) {
          db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          db.exec(`RELEASE SAVEPOINT ${sp}`);
          logger.error(`Migration v${migration.version} failed: ${e}`);
          throw e;
        }
      }
      setSchemaVersion(db, migration.version);
    }
    logger.log(`Schema version is now ${getSchemaVersion(db)}.`);
    fillNullWithDefaults(db);
  })();
}
