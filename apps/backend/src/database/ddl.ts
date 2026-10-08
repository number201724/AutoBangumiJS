/**
 * Fresh-database DDL — mirrors what SQLModel.metadata.create_all produces for
 * the current model set (no server-side DEFAULT clauses; model defaults are
 * applied at insert time, same as the Python backend).
 */
export const CREATE_TABLES_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS bangumi (
    id INTEGER PRIMARY KEY,
    official_title VARCHAR NOT NULL,
    year VARCHAR,
    title_raw VARCHAR NOT NULL,
    season INTEGER NOT NULL,
    season_raw VARCHAR,
    group_name VARCHAR,
    dpi VARCHAR,
    source VARCHAR,
    subtitle VARCHAR,
    eps_collect BOOLEAN NOT NULL,
    episode_offset INTEGER NOT NULL,
    season_offset INTEGER NOT NULL,
    filter VARCHAR NOT NULL,
    rss_link VARCHAR NOT NULL,
    poster_link VARCHAR,
    added BOOLEAN NOT NULL,
    rule_name VARCHAR,
    save_path VARCHAR,
    deleted BOOLEAN NOT NULL,
    archived BOOLEAN NOT NULL,
    air_weekday INTEGER,
    weekday_locked BOOLEAN NOT NULL,
    needs_review BOOLEAN NOT NULL,
    needs_review_reason VARCHAR,
    suggested_season_offset INTEGER,
    suggested_episode_offset INTEGER,
    title_aliases VARCHAR,
    preferred_group VARCHAR,
    preferred_resolution VARCHAR,
    episode_type VARCHAR NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_bangumi_title_raw ON bangumi(title_raw)`,
  `CREATE INDEX IF NOT EXISTS ix_bangumi_deleted ON bangumi(deleted)`,
  `CREATE INDEX IF NOT EXISTS ix_bangumi_archived ON bangumi(archived)`,

  `CREATE TABLE IF NOT EXISTS rssitem (
    id INTEGER PRIMARY KEY,
    name VARCHAR,
    url VARCHAR NOT NULL,
    aggregate BOOLEAN NOT NULL,
    parser VARCHAR NOT NULL,
    enabled BOOLEAN NOT NULL,
    connection_status VARCHAR,
    last_checked_at VARCHAR,
    last_error VARCHAR
  )`,
  `CREATE INDEX IF NOT EXISTS ix_rssitem_url ON rssitem(url)`,

  `CREATE TABLE IF NOT EXISTS torrent (
    id INTEGER PRIMARY KEY,
    bangumi_id INTEGER REFERENCES bangumi(id),
    rss_id INTEGER REFERENCES rssitem(id),
    name VARCHAR NOT NULL,
    url VARCHAR NOT NULL,
    homepage VARCHAR,
    downloaded BOOLEAN NOT NULL,
    qb_hash VARCHAR
  )`,
  `CREATE INDEX IF NOT EXISTS ix_torrent_bangumi_id ON torrent(bangumi_id)`,
  `CREATE INDEX IF NOT EXISTS ix_torrent_rss_id ON torrent(rss_id)`,
  `CREATE INDEX IF NOT EXISTS ix_torrent_url ON torrent(url)`,
  `CREATE INDEX IF NOT EXISTS ix_torrent_qb_hash ON torrent(qb_hash)`,

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
  `CREATE INDEX IF NOT EXISTS ix_movie_title_raw ON movie(title_raw)`,
  `CREATE INDEX IF NOT EXISTS ix_movie_deleted ON movie(deleted)`,

  `CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY,
    username VARCHAR NOT NULL UNIQUE,
    password VARCHAR NOT NULL,
    enabled BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ix_user_username ON user(username)`,
  `CREATE INDEX IF NOT EXISTS ix_user_enabled ON user(enabled)`,

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
  `CREATE INDEX IF NOT EXISTS ix_passkey_user_id ON passkey(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ix_passkey_credential_id ON passkey(credential_id)`,

  `CREATE TABLE IF NOT EXISTS auth_session (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES user(id),
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL,
    last_seen_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS ix_auth_session_user_id ON auth_session(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ix_auth_session_token_hash ON auth_session(token_hash)`,
  `CREATE INDEX IF NOT EXISTS ix_auth_session_expires_at ON auth_session(expires_at)`,
  `CREATE INDEX IF NOT EXISTS ix_auth_session_revoked_at ON auth_session(revoked_at)`,

  // v20 final shape (composite identity, redacted prefixes)
  `CREATE TABLE IF NOT EXISTS api_token (
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
  `CREATE INDEX IF NOT EXISTS ix_api_token_user_id ON api_token(user_id)`,
  `CREATE INDEX IF NOT EXISTS ix_api_token_scope ON api_token(scope)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ix_api_token_token_hash_scope ON api_token(token_hash, scope)`,
  `CREATE INDEX IF NOT EXISTS ix_api_token_expires_at ON api_token(expires_at)`,
  `CREATE INDEX IF NOT EXISTS ix_api_token_revoked_at ON api_token(revoked_at)`,

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
  `CREATE INDEX IF NOT EXISTS ix_inboxmessage_kind ON inboxmessage(kind)`,
  `CREATE INDEX IF NOT EXISTS ix_inboxmessage_dedup_key ON inboxmessage(dedup_key)`,
  `CREATE INDEX IF NOT EXISTS ix_inboxmessage_read ON inboxmessage(read)`,

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
  `CREATE UNIQUE INDEX IF NOT EXISTS ix_llmcredential_provider_id ON llmcredential(provider_id)`,

  `CREATE TABLE IF NOT EXISTS aria2_gid (
    gid VARCHAR NOT NULL PRIMARY KEY,
    bangumi_id INTEGER REFERENCES bangumi(id),
    category VARCHAR,
    dedup_key VARCHAR,
    renamed_paths TEXT DEFAULT NULL,
    rename_intent TEXT DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS ix_aria2_gid_dedup_key ON aria2_gid(dedup_key)`,

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
  `CREATE INDEX IF NOT EXISTS ix_rename_operation_state_retry_at ON rename_operation(state, retry_at)`,
  `CREATE INDEX IF NOT EXISTS ix_rename_operation_new_task_id ON rename_operation(new_task_id)`,
  `CREATE INDEX IF NOT EXISTS ix_rename_operation_old_task_id ON rename_operation(old_task_id)`,
];

export const ENSURE_SCHEMA_VERSION_DDL = `CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL
)`;
