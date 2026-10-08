/**
 * Drizzle schema — mirrors module/models/*.py (SQLModel table models).
 *
 * Property names intentionally use the snake_case DB column names so query
 * results serialize directly to the API contract (Python's field names).
 * Datetime columns are stored as TEXT in SQLAlchemy's SQLite format
 * ('YYYY-MM-DD HH:MM:SS.ffffff', UTC, naive) for data.db compatibility.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const bangumi = sqliteTable(
  'bangumi',
  {
    id: integer('id').primaryKey(),
    official_title: text('official_title').notNull(),
    year: text('year'),
    title_raw: text('title_raw').notNull(),
    season: integer('season').notNull(),
    season_raw: text('season_raw'),
    group_name: text('group_name'),
    dpi: text('dpi'),
    source: text('source'),
    subtitle: text('subtitle'),
    eps_collect: integer('eps_collect', { mode: 'boolean' }).notNull(),
    episode_offset: integer('episode_offset').notNull(),
    season_offset: integer('season_offset').notNull(),
    filter: text('filter').notNull(),
    rss_link: text('rss_link').notNull(),
    poster_link: text('poster_link'),
    added: integer('added', { mode: 'boolean' }).notNull(),
    rule_name: text('rule_name'),
    save_path: text('save_path'),
    deleted: integer('deleted', { mode: 'boolean' }).notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull(),
    air_weekday: integer('air_weekday'),
    weekday_locked: integer('weekday_locked', { mode: 'boolean' }).notNull(),
    needs_review: integer('needs_review', { mode: 'boolean' }).notNull(),
    needs_review_reason: text('needs_review_reason'),
    suggested_season_offset: integer('suggested_season_offset'),
    suggested_episode_offset: integer('suggested_episode_offset'),
    title_aliases: text('title_aliases'),
    preferred_group: text('preferred_group'),
    preferred_resolution: text('preferred_resolution'),
    episode_type: text('episode_type').notNull(),
  },
  (t) => [
    index('ix_bangumi_title_raw').on(t.title_raw),
    index('ix_bangumi_deleted').on(t.deleted),
    index('ix_bangumi_archived').on(t.archived),
  ],
);

export const rssitem = sqliteTable(
  'rssitem',
  {
    id: integer('id').primaryKey(),
    name: text('name'),
    url: text('url').notNull(),
    aggregate: integer('aggregate', { mode: 'boolean' }).notNull(),
    parser: text('parser').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    connection_status: text('connection_status'),
    last_checked_at: text('last_checked_at'),
    last_error: text('last_error'),
  },
  (t) => [index('ix_rssitem_url').on(t.url)],
);

export const torrent = sqliteTable(
  'torrent',
  {
    id: integer('id').primaryKey(),
    bangumi_id: integer('bangumi_id').references(() => bangumi.id),
    rss_id: integer('rss_id').references(() => rssitem.id),
    name: text('name').notNull(),
    url: text('url').notNull(),
    homepage: text('homepage'),
    downloaded: integer('downloaded', { mode: 'boolean' }).notNull(),
    qb_hash: text('qb_hash'),
  },
  (t) => [
    index('ix_torrent_bangumi_id').on(t.bangumi_id),
    index('ix_torrent_rss_id').on(t.rss_id),
    index('ix_torrent_url').on(t.url),
    index('ix_torrent_qb_hash').on(t.qb_hash),
  ],
);

export const movie = sqliteTable(
  'movie',
  {
    id: integer('id').primaryKey(),
    official_title: text('official_title').notNull(),
    title_raw: text('title_raw'),
    year: integer('year'),
    group_name: text('group_name'),
    dpi: text('dpi'),
    source: text('source'),
    subtitle: text('subtitle'),
    poster_link: text('poster_link'),
    rss_link: text('rss_link'),
    added: integer('added', { mode: 'boolean' }).notNull(),
    deleted: integer('deleted', { mode: 'boolean' }).notNull(),
    save_path: text('save_path'),
    rule_name: text('rule_name'),
    filter: text('filter').notNull(),
  },
  (t) => [index('ix_movie_title_raw').on(t.title_raw), index('ix_movie_deleted').on(t.deleted)],
);

export const user = sqliteTable(
  'user',
  {
    id: integer('id').primaryKey(),
    username: text('username').notNull().unique(),
    password: text('password').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('ix_user_username').on(t.username),
    index('ix_user_enabled').on(t.enabled),
  ],
);

export const passkey = sqliteTable(
  'passkey',
  {
    id: integer('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => user.id),
    name: text('name').notNull(),
    credential_id: text('credential_id').notNull().unique(),
    public_key: text('public_key').notNull(),
    sign_count: integer('sign_count'),
    aaguid: text('aaguid'),
    transports: text('transports'),
    created_at: text('created_at'),
    last_used_at: text('last_used_at'),
    backup_eligible: integer('backup_eligible', { mode: 'boolean' }),
    backup_state: integer('backup_state', { mode: 'boolean' }),
  },
  (t) => [
    index('ix_passkey_user_id').on(t.user_id),
    uniqueIndex('ix_passkey_credential_id').on(t.credential_id),
  ],
);

export const authSession = sqliteTable(
  'auth_session',
  {
    id: integer('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => user.id),
    token_hash: text('token_hash').notNull().unique(),
    created_at: text('created_at').notNull(),
    last_seen_at: text('last_seen_at').notNull(),
    expires_at: text('expires_at').notNull(),
    revoked_at: text('revoked_at'),
  },
  (t) => [
    index('ix_auth_session_user_id').on(t.user_id),
    uniqueIndex('ix_auth_session_token_hash').on(t.token_hash),
    index('ix_auth_session_expires_at').on(t.expires_at),
    index('ix_auth_session_revoked_at').on(t.revoked_at),
  ],
);

export const apiToken = sqliteTable(
  'api_token',
  {
    id: integer('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => user.id),
    name: text('name').notNull(),
    scope: text('scope').notNull(),
    token_hash: text('token_hash').notNull(),
    prefix: text('prefix').notNull(),
    created_at: text('created_at').notNull(),
    last_used_at: text('last_used_at'),
    expires_at: text('expires_at'),
    revoked_at: text('revoked_at'),
  },
  (t) => [
    index('ix_api_token_user_id').on(t.user_id),
    index('ix_api_token_scope').on(t.scope),
    uniqueIndex('ix_api_token_token_hash_scope').on(t.token_hash, t.scope),
    index('ix_api_token_expires_at').on(t.expires_at),
    index('ix_api_token_revoked_at').on(t.revoked_at),
  ],
);

export const inboxmessage = sqliteTable(
  'inboxmessage',
  {
    id: integer('id').primaryKey(),
    kind: text('kind').notNull().default(''),
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    payload: text('payload'),
    dedup_key: text('dedup_key'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    count: integer('count').notNull().default(1),
    created_at: text('created_at').notNull().default(''),
    updated_at: text('updated_at').notNull().default(''),
  },
  (t) => [
    index('ix_inboxmessage_kind').on(t.kind),
    index('ix_inboxmessage_dedup_key').on(t.dedup_key),
    index('ix_inboxmessage_read').on(t.read),
  ],
);

export const llmcredential = sqliteTable(
  'llmcredential',
  {
    id: integer('id').primaryKey(),
    provider_id: text('provider_id').notNull().default(''),
    access_token: text('access_token').notNull().default(''),
    refresh_token: text('refresh_token').notNull().default(''),
    expires_at: real('expires_at'),
    account_label: text('account_label').notNull().default(''),
    extra: text('extra'),
    updated_at: text('updated_at').notNull().default(''),
  },
  (t) => [uniqueIndex('ix_llmcredential_provider_id').on(t.provider_id)],
);

export const aria2Gid = sqliteTable(
  'aria2_gid',
  {
    gid: text('gid').primaryKey(),
    bangumi_id: integer('bangumi_id').references(() => bangumi.id),
    category: text('category'),
    dedup_key: text('dedup_key'),
    renamed_paths: text('renamed_paths'),
    rename_intent: text('rename_intent'),
    created_at: text('created_at').notNull(),
  },
  (t) => [index('ix_aria2_gid_dedup_key').on(t.dedup_key)],
);

export const RENAME_OPERATION_STATES = [
  'conflict',
  'retry',
  'running',
  'planned',
  'old_staged',
  'new_promoted',
  'old_removed',
  'done',
] as const;
export type RenameOperationState = (typeof RENAME_OPERATION_STATES)[number];

export const renameOperation = sqliteTable(
  'rename_operation',
  {
    id: integer('id').primaryKey(),
    downloader_type: text('downloader_type').notNull(),
    kind: text('kind').notNull().default('conflict'),
    state: text('state').notNull().default('planned'),
    new_task_id: text('new_task_id').notNull(),
    old_task_id: text('old_task_id'),
    save_path: text('save_path').notNull(),
    source_path: text('source_path').notNull(),
    target_path: text('target_path').notNull(),
    staged_path: text('staged_path'),
    bangumi_id: integer('bangumi_id'),
    media_type: text('media_type'),
    season: integer('season'),
    episode: real('episode'),
    group_name: text('group_name'),
    resolution: text('resolution'),
    old_revision: integer('old_revision'),
    new_revision: integer('new_revision'),
    revision_metadata: text('revision_metadata'),
    attempt_count: integer('attempt_count').notNull().default(0),
    retry_at: text('retry_at'),
    lease_owner: text('lease_owner'),
    lease_expires_at: text('lease_expires_at'),
    notified_at: text('notified_at'),
    last_error: text('last_error'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    check(
      'ck_rename_operation_state',
      sql`state IN ('conflict', 'retry', 'running', 'planned', 'old_staged', 'new_promoted', 'old_removed', 'done')`,
    ),
    check('ck_rename_operation_attempt_count', sql`attempt_count >= 0`),
    uniqueIndex('ux_rename_operation_identity').on(
      t.downloader_type,
      t.new_task_id,
      t.save_path,
      t.source_path,
      t.target_path,
    ),
    uniqueIndex('ux_rename_operation_active_target')
      .on(t.downloader_type, t.save_path, t.target_path)
      .where(sql`state NOT IN ('done')`),
    index('ix_rename_operation_state_retry_at').on(t.state, t.retry_at),
    index('ix_rename_operation_new_task_id').on(t.new_task_id),
    index('ix_rename_operation_old_task_id').on(t.old_task_id),
  ],
);

export const schemaVersion = sqliteTable('schema_version', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull(),
});

// ---------------------------------------------------------------------------
// Row types (snake_case — identical to the API serialization shape)
// ---------------------------------------------------------------------------

export type BangumiRow = typeof bangumi.$inferSelect;
export type NewBangumiRow = typeof bangumi.$inferInsert;
export type RssRow = typeof rssitem.$inferSelect;
export type NewRssRow = typeof rssitem.$inferInsert;
export type TorrentRow = typeof torrent.$inferSelect;
export type NewTorrentRow = typeof torrent.$inferInsert;
export type MovieRow = typeof movie.$inferSelect;
export type NewMovieRow = typeof movie.$inferInsert;
export type UserRow = typeof user.$inferSelect;
export type NewUserRow = typeof user.$inferInsert;
export type PasskeyRow = typeof passkey.$inferSelect;
export type NewPasskeyRow = typeof passkey.$inferInsert;
export type AuthSessionRow = typeof authSession.$inferSelect;
export type NewAuthSessionRow = typeof authSession.$inferInsert;
export type ApiTokenRow = typeof apiToken.$inferSelect;
export type NewApiTokenRow = typeof apiToken.$inferInsert;
export type InboxRow = typeof inboxmessage.$inferSelect;
export type NewInboxRow = typeof inboxmessage.$inferInsert;
export type LLMCredentialRow = typeof llmcredential.$inferSelect;
export type Aria2GidRow = typeof aria2Gid.$inferSelect;
export type NewAria2GidRow = typeof aria2Gid.$inferInsert;
export type RenameOperationRow = typeof renameOperation.$inferSelect;
export type NewRenameOperationRow = typeof renameOperation.$inferInsert;
