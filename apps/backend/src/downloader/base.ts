/**
 * Download-client protocol and capability declarations — 1:1 port of
 * module/downloader/base.py.
 *
 * `DownloadClient` (the facade) delegates every concrete operation to an object
 * that implements `DownloaderClient`. Different backends support different subsets
 * of the qBittorrent surface, so each concrete client advertises what it can do
 * via a `capabilities` attribute; the facade consults it and skips unsupported
 * operations instead of blowing up on a missing method.
 */

/** Torrent-add result shared by concrete clients and the facade. */
export enum AddResult {
  ADDED = 'added',
  DUPLICATE = 'duplicate',
  FAILED = 'failed',
}

/** Downloader-independent outcome of a single file rename. */
export enum RenameOutcome {
  RENAMED = 'renamed',
  ALREADY_APPLIED = 'already_applied',
  DESTINATION_EXISTS = 'destination_exists',
  RETRYABLE_FAILURE = 'retryable_failure',
}

/**
 * Structured rename result preserved across the downloader facade.
 *
 * `result.succeeded` deliberately keeps the old success/failure behaviour while
 * callers migrate to inspecting `outcome`. It must never make a collision or
 * retryable failure truthy.
 */
export class RenameResult {
  constructor(
    readonly outcome: RenameOutcome,
    readonly detail: string | null = null,
  ) {}

  get succeeded(): boolean {
    return (
      this.outcome === RenameOutcome.RENAMED ||
      this.outcome === RenameOutcome.ALREADY_APPLIED
    );
  }
}

/**
 * What a concrete download client can do.
 *
 * can_query     -- torrents_info / torrents_files / get_torrents_by_tag
 * can_rename    -- torrents_rename_file
 * can_manage    -- delete / pause / resume / move / category / tags
 * can_rss_rules -- qB-native RSS feeds + auto-download rules + prefs
 */
export interface DownloaderCapabilities {
  can_query: boolean;
  can_rename: boolean;
  can_manage: boolean;
  can_rss_rules: boolean;
}

/** The minimum every backend must implement: authenticate and add torrents. */
export interface CoreDownloaderClient {
  readonly capabilities: DownloaderCapabilities;

  auth(retry?: number): Promise<boolean>;

  logout(): Promise<void>;

  addTorrents(
    torrentUrls: string | string[] | null,
    torrentFiles: Buffer | Buffer[] | null,
    savePath: string,
    category: string,
    tags?: string | null,
  ): Promise<AddResult>;
}

/**
 * The full async surface `DownloadClient` delegates to.
 *
 * A backend that satisfies this interface supports every facade operation. A
 * backend that only satisfies `CoreDownloaderClient` is limited to auth and
 * adding torrents; the facade guards the rest with `capabilities`.
 */
export interface DownloaderClient extends CoreDownloaderClient {
  // Session lifecycle / connectivity
  checkConnection(): Promise<string>;

  // Preferences / setup
  prefsInit(prefs: Record<string, unknown>): Promise<unknown>;

  getAppPrefs(): Promise<Record<string, unknown>>;

  addCategory(category: string): Promise<void>;

  // Torrent lifecycle
  torrentsInfo(
    statusFilter: string | null,
    category: string | null,
    tag?: string | null,
  ): Promise<Array<Record<string, unknown>>>;

  torrentExists(torrentHash: string): Promise<boolean | null>;

  torrentsFiles(torrentHash: string): Promise<Array<Record<string, unknown>>>;

  torrentsDelete(hash: string | string[], deleteFiles?: boolean): Promise<boolean>;

  torrentsPause(hashes: string | string[]): Promise<void>;

  torrentsResume(hashes: string | string[]): Promise<void>;

  torrentsRenameFile(
    torrentHash: string,
    oldPath: string,
    newPath: string,
    verify?: boolean,
  ): Promise<RenameResult>;

  moveTorrent(hashes: string | string[], newLocation: string): Promise<void>;

  setCategory(hash: string | string[], category: string): Promise<void>;

  // Tagging
  addTag(hash: string, tag: string): Promise<void>;

  // RSS auto-download rules
  rssSetRule(ruleName: string, ruleDef: Record<string, unknown>): Promise<void>;
}

/**
 * Python `DownloaderClient` Protocol 的结构化等价物：后端可以只实现子集
 * （如 aria2 没有 qB 原生 RSS-rule/prefs 面），门面按 capabilities 守卫，
 * 未实现的方法永不调用（对应 Python 里的 `type: ignore[return-value]`）。
 */
export type ConcreteDownloaderClient = CoreDownloaderClient &
  Partial<Omit<DownloaderClient, keyof CoreDownloaderClient>> & {
    /** 最近一次认证失败的原因（unreachable | credentials | banned），仅 qB 实现。 */
    lastAuthError?: string | null;
  };

/** Python builtin ConnectionError 的等价物（下载层表达连接/认证失败）。 */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** asyncio.sleep 的等价物（参数为秒）。 */
export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * asyncio.Lock 的等价物：promise 链串行化临界区（单飞）。
 * 并发调用按到达顺序依次执行 fn，任一 fn 拒绝（reject）不会卡死后续等待者。
 */
export class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
