/**
 * Shared API contract types for Auto_Bangumi (Node.js rewrite).
 * Field names match the Python backend's JSON serialization (model field names,
 * not aliases — e.g. torrent uses `bangumi_id`, not `refer_id`).
 */

// ---------------------------------------------------------------------------
// Config (mirrors module/models/config.py, serialized by_alias=True so the
// underscore-suffixed Python fields appear as their aliases here)
// ---------------------------------------------------------------------------

export interface ProgramConfig {
  rss_time: number;
  rename_time: number;
  webui_port: number;
}

export interface DownloaderConfig {
  type: string;
  host: string;
  username: string;
  password: string;
  path: string;
  ssl: boolean;
}

export interface RssParserConfig {
  enable: boolean;
  filter: string[];
  language: string;
  engine: 'classic' | 'tokenizer';
}

export interface BangumiManageConfig {
  enable: boolean;
  eps_complete: boolean;
  rename_method: string;
  group_tag: boolean;
  remove_bad_torrent: boolean;
  revision_conflict_policy: 'hold' | 'replace';
  track_orphans: boolean;
}

export interface LogConfig {
  debug_enable: boolean;
}

export interface NetworkConfig {
  tmdb_base_url: string;
  tmdb_api_key: string;
  bgm_base_url: string;
}

export interface ProxyConfig {
  enable: boolean;
  type: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface NotificationProviderConfig {
  type: string;
  enabled: boolean;
  token?: string | null;
  chat_id?: string | null;
  webhook_url?: string | null;
  server_url?: string | null;
  device_key?: string | null;
  user_key?: string | null;
  api_token?: string | null;
  template?: string | null;
  url?: string | null;
}

export interface NotificationConfig {
  enable: boolean;
  providers: NotificationProviderConfig[];
  base_url: string;
  /** [Deprecated] legacy single-provider fields */
  type?: string | null;
  token?: string | null;
  chat_id?: string | null;
}

export interface LLMProviderOverride {
  api_key: string;
  model: string;
  base_url: string;
}

export interface LLMConfig {
  enable: boolean;
  provider: string;
  api_key: string;
  model: string;
  base_url: string;
  mode: 'fallback' | 'primary';
  timeout: number;
  cache_ttl: number;
  max_concurrency: number;
  failure_threshold: number;
  failure_backoff: number;
  providers: Record<string, LLMProviderOverride>;
}

/** [Deprecated] kept for reading old config files only */
export interface ExperimentalOpenAIConfig {
  enable: boolean;
  api_key: string;
  api_base: string;
  api_type: 'azure' | 'openai';
  api_version: string;
  model: string;
  deployment_id: string;
}

export interface SecurityConfig {
  login_whitelist: string[];
  login_tokens: string[];
  mcp_whitelist: string[];
  mcp_tokens: string[];
  webauthn_rp_id: string;
  webauthn_origin: string;
}

export interface UpdateConfig {
  channel: 'stable' | 'beta';
  auto_check: boolean;
}

export interface Config {
  program: ProgramConfig;
  downloader: DownloaderConfig;
  rss_parser: RssParserConfig;
  bangumi_manage: BangumiManageConfig;
  log: LogConfig;
  network: NetworkConfig;
  proxy: ProxyConfig;
  notification: NotificationConfig;
  llm: LLMConfig;
  experimental_openai: ExperimentalOpenAIConfig;
  security: SecurityConfig;
  update: UpdateConfig;
}

// ---------------------------------------------------------------------------
// Entities (API serialization shapes)
// ---------------------------------------------------------------------------

export interface Bangumi {
  id: number;
  official_title: string;
  year: string | null;
  title_raw: string;
  season: number;
  season_raw: string | null;
  group_name: string | null;
  dpi: string | null;
  source: string | null;
  subtitle: string | null;
  eps_collect: boolean;
  episode_offset: number;
  season_offset: number;
  filter: string;
  rss_link: string;
  poster_link: string | null;
  added: boolean;
  rule_name: string | null;
  save_path: string | null;
  deleted: boolean;
  archived: boolean;
  air_weekday: number | null;
  weekday_locked: boolean;
  needs_review: boolean;
  needs_review_reason: string | null;
  suggested_season_offset: number | null;
  suggested_episode_offset: number | null;
  title_aliases: string | null;
  preferred_group: string | null;
  preferred_resolution: string | null;
  episode_type: string;
}

export interface RSS {
  id: number;
  name: string | null;
  url: string;
  aggregate: boolean;
  parser: string;
  enabled: boolean;
  connection_status: string | null;
  last_checked_at: string | null;
  last_error: string | null;
}

export interface Torrent {
  id: number;
  bangumi_id: number | null;
  rss_id: number | null;
  name: string;
  url: string;
  homepage: string | null;
  downloaded: boolean;
  qb_hash: string | null;
}

export interface Movie {
  id: number;
  official_title: string;
  title_raw: string | null;
  year: number | null;
  group_name: string | null;
  dpi: string | null;
  source: string | null;
  subtitle: string | null;
  poster_link: string | null;
  rss_link: string | null;
  added: boolean;
  deleted: boolean;
  save_path: string | null;
  rule_name: string | null;
  filter: string;
}

export interface UserPublic {
  id: number;
  username: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiTokenPublic {
  id: number;
  user_id: number;
  name: string;
  scope: 'api' | 'mcp';
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface ApiTokenCreated extends ApiTokenPublic {
  token: string;
}

export interface InboxMessage {
  id: number;
  kind: string;
  severity: string;
  title: string;
  body: string;
  payload: string | null;
  dedup_key: string | null;
  read: boolean;
  count: number;
  created_at: string;
  updated_at: string;
}

export interface RenameOperation {
  id: number;
  downloader_type: string;
  kind: string;
  state: string;
  new_task_id: string;
  old_task_id: string | null;
  save_path: string;
  source_path: string;
  target_path: string;
  staged_path: string | null;
  bangumi_id: number | null;
  media_type: string | null;
  season: number | null;
  episode: number | null;
  group_name: string | null;
  resolution: string | null;
  old_revision: number | null;
  new_revision: number | null;
  revision_metadata: string | null;
  attempt_count: number;
  retry_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  notified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Response envelope (module/models/response.py)
// ---------------------------------------------------------------------------

export interface ResponseModel<T = unknown> {
  status: boolean;
  status_code: number;
  msg_en: string;
  msg_zh: string;
  data: T | null;
}
