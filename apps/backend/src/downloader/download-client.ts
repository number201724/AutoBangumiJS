/**
 * Unified async download client facade — 1:1 port of
 * module/downloader/download_client.py.
 *
 * Python 端用法是 `async with DownloadClient() as client:`；TS 没有对应的
 * 协议，等价写法为：
 *
 *   const client = await new DownloadClient().enter();
 *   try {
 *     ...
 *   } finally {
 *     await client.exit();
 *   }
 *
 * Python 在 __getClient 里惰性 import 具体客户端（避免循环依赖）；TS 侧
 * 在 createConcreteClient 里用 require 保持同样的惰性加载。
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { RequestContent } from '../network/request-contents';
import { expandEnv } from '../utils/env';
import {
  AddResult,
  AsyncLock,
  ConnectionError,
  type ConcreteDownloaderClient,
  type DownloaderCapabilities,
  RenameOutcome,
  RenameResult,
  sleep,
} from './base';
import { genSavePath, type MediaPathData } from './path';

const logger = new Logger('DownloadClient');

// 同一主机批量抓取 .torrent 文件的请求间隔（#1052）。批量收集整季时并发抓取
// 会触发 nyaa 等站点的 429 限流；与 rss/engine.py 的 RSS_PER_HOST_DELAY 同思路，
// 但这里是收集接口内的一次性批量抓取，取 1s 以控制接口延迟（24 集约 +23s）。
const TORRENT_FETCH_PER_HOST_DELAY = 1.0;

/** 种子输入的最小形状（models.Torrent / network TorrentData 的结构子集）。 */
export interface TorrentLike {
  url: string;
}

/** addTorrent 的 bangumi 参数：gen_save_path 所需字段 + id/official_title/save_path。 */
export interface AddTorrentBangumi extends MediaPathData {
  id?: number | null;
  official_title: string;
  save_path?: string | null;
}

/** 抓取种子文件内容：同主机串行加延时，不同主机并行，失败项丢弃（#1052）。 */
async function fetchTorrentFiles(
  req: RequestContent,
  torrents: TorrentLike[],
): Promise<Buffer[]> {
  const byHost = new Map<string, TorrentLike[]>();
  for (const t of torrents) {
    // urlparse(t.url).netloc 对非法 URL 返回 '' 而不抛错，这里对齐
    let host = '';
    try {
      host = new URL(t.url).host;
    } catch {
      host = '';
    }
    const group = byHost.get(host) ?? [];
    group.push(t);
    byHost.set(host, group);
  }

  const fetchHostGroup = async (items: TorrentLike[]): Promise<Buffer[]> => {
    const files: Buffer[] = [];
    for (const [i, t] of items.entries()) {
      if (i && TORRENT_FETCH_PER_HOST_DELAY) {
        await sleep(TORRENT_FETCH_PER_HOST_DELAY);
      }
      const content = await req.getContent(t.url);
      if (content !== null) {
        files.push(content);
      }
    }
    return files;
  };

  const groups = await Promise.all([...byHost.values()].map((items) => fetchHostGroup(items)));
  return groups.flat();
}

// ---------------------------------------------------------------------------
// Module-level concrete-client cache (session reuse, #1039 / #900)
//
// Every `DownloadClient` used to spin up a fresh concrete client
// and log in on enter / log out on exit -- one qB login+logout per operation,
// roughly once a minute from the rename loop. The cache keeps a single concrete
// client alive across operations, keyed by the connection-relevant settings.
//
// Closing a concrete client while another overlapping entered block is still
// using it (mid-request) would kill that request out from under it.
// `activeHolders` reference-counts how many entered-but-not-yet-exited blocks
// currently hold each client (keyed by object identity, like Python's
// `id(client)`); a client is only actually logged out once its count drops
// to zero -- either immediately (nobody holds it) or deferred to whichever
// block's exit() is the last to let go (`pendingClose`).
// `bookkeepingLock` serializes reads/writes of this shared state across the
// awaits in enter()/exit().
// ---------------------------------------------------------------------------

/** JSON 序列化的连接设置 key（数组无法按值比较，用其字符串形式）。 */
type SettingsKey = string;

let clientCache: [SettingsKey, ConcreteDownloaderClient] | null = null;
let staleClients: ConcreteDownloaderClient[] = [];
const activeHolders = new Map<ConcreteDownloaderClient, number>();
const pendingClose = new Set<ConcreteDownloaderClient>();
const bookkeepingLock = new AsyncLock();
// 凭据被服务端明确拒绝后的闩锁：记录失败时的连接设置 key。命中时 enter 直接
// 失败、不再发 login POST——每个 tick 重试一次登录，约 5 次即触发 qB 的
// WebUI IP ban。设置变更（key 不同）自然解锁；同值重存经
// clearCredentialLatch()（AppContext.reload_settings）解锁。
let credentialFailedKey: SettingsKey | null = null;

// Warn at most once per (client type, operation) when a backend cannot perform
// an operation, so aria2 users are not spammed every rename cycle.
const warnedUnsupported = new Set<string>();

function settingsKey(): SettingsKey {
  const d = settings.data.downloader;
  // 与 Python 一致：host/username/password 在使用处展开 $VAR（property 语义）
  return JSON.stringify([
    d.type,
    expandEnv(d.host),
    expandEnv(d.username),
    expandEnv(d.password),
    d.ssl,
  ]);
}

/** Drop the cached/stale concrete clients and refcount state (used by tests). */
export function resetClientCache(): void {
  clientCache = null;
  staleClients = [];
  activeHolders.clear();
  pendingClose.clear();
  clearCredentialLatch();
}

/** 解除凭据失败闩锁（配置保存后调用，允许用户重试同值凭据）。 */
export function clearCredentialLatch(): void {
  credentialFailedKey = null;
}

async function closeClient(client: ConcreteDownloaderClient): Promise<void> {
  try {
    await client.logout();
  } catch (e) {
    logger.debug(`Error closing client: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Log out and close the cached concrete client.
 *
 * Invoked by the composition root (`AppContext`) on application shutdown.
 */
export async function shutdown(): Promise<void> {
  const clients = [...staleClients];
  if (clientCache !== null) {
    clients.push(clientCache[1]);
  }
  clientCache = null;
  staleClients = [];
  for (const client of clients) {
    await closeClient(client);
  }
}

/** Instantiate the configured downloader client (qbittorrent | aria2 | mock). */
function createConcreteClient(): ConcreteDownloaderClient {
  const d = settings.data.downloader;
  const downloaderType = d.type;
  // host/username/password 是未展开的原始值，这里展开（Python property 语义）
  const host = expandEnv(d.host);
  const username = expandEnv(d.username);
  const password = expandEnv(d.password);
  const ssl = d.ssl;
  if (downloaderType === 'qbittorrent') {
    const { QbDownloader } =
      require('./client/qb-downloader') as typeof import('./client/qb-downloader');
    return new QbDownloader(host, username, password, ssl);
  }
  if (downloaderType === 'aria2') {
    const { Aria2Downloader } =
      require('./client/aria2-downloader') as typeof import('./client/aria2-downloader');
    // Aria2Downloader implements query/rename/manage for real (see its
    // `capabilities`), but has no qB-native RSS-rule/prefs surface
    // (can_rss_rules=false), so it stays structurally narrower than
    // the full `DownloaderClient` interface -- the facade skips the
    // rss/prefs methods it never calls on this backend.
    return new Aria2Downloader(host, username, password);
  }
  if (downloaderType === 'mock') {
    const { MockDownloader } =
      require('./client/mock-downloader') as typeof import('./client/mock-downloader');
    logger.debug('Using MockDownloader for local development');
    return new MockDownloader();
  }
  logger.error(`Unsupported downloader type: ${downloaderType}`);
  throw new Error(`Unsupported downloader type: ${downloaderType}`);
}

/**
 * Unified async download client.
 *
 * Wraps qBittorrent, Aria2, or MockDownloader behind a common interface.
 * Intended to be entered via `enter()`/`exit()`; authentication is
 * performed on `enter()`. The concrete client's session is reused across
 * enter/exit blocks (see the module-level cache above) and only torn
 * down by `shutdown()`.
 */
export class DownloadClient {
  readonly client: ConcreteDownloaderClient;
  private readonly cacheKey: SettingsKey;
  authed = false;

  constructor() {
    const key = settingsKey();
    this.cacheKey = key;
    if (clientCache !== null && clientCache[0] === key) {
      this.client = clientCache[1];
    } else {
      if (clientCache !== null) {
        // Settings changed: retire the previous client, close it later.
        // 用列表累积——连续两次改设置（期间没有 enter）不得把第一个
        // 被撤下的客户端顶掉，否则它的连接池泄漏到进程结束。
        staleClients.push(clientCache[1]);
      }
      this.client = createConcreteClient();
      clientCache = [key, this.client];
    }
    this.authed = false;
  }

  /**
   * 最近一次认证失败的原因（unreachable | credentials | banned）。
   *
   * 仅 qBittorrent 客户端会区分原因；aria2/mock 无此属性时返回 null。
   */
  get lastAuthError(): string | null {
    return this.client.lastAuthError ?? null;
  }

  /** Whether the concrete client can perform ``op`` (log once if not). */
  private supports(capability: keyof DownloaderCapabilities, op: string): boolean {
    const caps = this.client.capabilities;
    if (caps !== null && caps !== undefined && caps[capability]) {
      return true;
    }
    const clientName = this.client.constructor.name;
    const key = `${clientName}:${op}`;
    if (!warnedUnsupported.has(key)) {
      warnedUnsupported.add(key);
      logger.warn(`${clientName} does not support '${op}'; skipping.`);
    }
    return false;
  }

  /** Python `__aenter__`：认证并计入引用计数；失败时抛出 ConnectionError。 */
  async enter(): Promise<this> {
    if (credentialFailedKey !== null && credentialFailedKey === this.cacheKey) {
      // 凭据上次已被服务端明确拒绝且设置未变：不再发 login POST，
      // 避免逐 tick 累积到 qB 的 IP ban。checker/等待循环读的是
      // 具体客户端上的失败原因，这里补齐。
      if ('lastAuthError' in this.client) {
        this.client.lastAuthError = 'credentials';
      }
      throw new ConnectionError(
        'Download client credentials were rejected previously; ' +
          'update the downloader settings to retry',
      );
    }

    const staleToClose: ConcreteDownloaderClient[] = [];
    await bookkeepingLock.run(async () => {
      // 先把自己计入引用——auth() 是 await 点，期间一个"设置变更"块
      // 可能进来关闭被撤下的客户端；不先占坑的话，自己正在登录的
      // 客户端会被从脚下抽走。
      activeHolders.set(this.client, (activeHolders.get(this.client) ?? 0) + 1);
      while (staleClients.length) {
        const stale = staleClients.pop()!;
        if ((activeHolders.get(stale) ?? 0) > 0) {
          // Still in use by another overlapping block; the last
          // holder's exit() will close it once released.
          pendingClose.add(stale);
        } else {
          staleToClose.push(stale);
        }
      }
    });
    for (const stale of staleToClose) {
      await closeClient(stale);
    }

    if (!this.authed) {
      // exit() never runs when enter() raises, so every exit path
      // below must release the holder slot itself -- including
      // cancellation mid-login, or the count leaks and a retired client
      // stays pending-close (pool open) forever.
      try {
        await this.auth();
      } catch (e) {
        await this.releaseHolder();
        throw e;
      }
      if (!this.authed) {
        if (this.lastAuthError === 'credentials') {
          credentialFailedKey = this.cacheKey;
        }
        // Release our slot and close the concrete client's connection
        // pool now or it leaks on every failed connect (#1043) --
        // unless another already-entered block still holds it, in
        // which case defer to its exit() instead of yanking the
        // pool out from under it.
        await bookkeepingLock.run(async () => {
          if (clientCache !== null && clientCache[1] === this.client) {
            clientCache = null;
          }
          pendingClose.add(this.client);
        });
        await this.releaseHolder();
        throw new ConnectionError('Download client authentication failed');
      }
    }

    return this;
  }

  /** 释放本块对具体客户端的引用；若是最后一个且已标记待关，则关闭。 */
  private async releaseHolder(): Promise<void> {
    const client = this.client;
    let toClose = false;
    await bookkeepingLock.run(async () => {
      const count = (activeHolders.get(client) ?? 0) - 1;
      if (count <= 0) {
        activeHolders.delete(client);
        if (pendingClose.has(client)) {
          pendingClose.delete(client);
          toClose = true;
        }
      } else {
        activeHolders.set(client, count);
      }
    });
    if (toClose) {
      await closeClient(client);
    }
  }

  /** Python `__aexit__`：释放引用，最后一个持有者负责延迟关闭。 */
  async exit(): Promise<void> {
    // The concrete session is reused across operations; do NOT log out
    // here unless this was the last holder of a client that a concurrent
    // block already marked for (deferred) close. Teardown is otherwise
    // deferred to shutdown() (composition root).
    this.authed = false;
    await this.releaseHolder();
  }

  /**
   * Ergonomic `async with DownloadClient() as client:` equivalent:
   * enter, run fn, always exit.
   */
  async withClient<T>(fn: (client: this) => Promise<T>): Promise<T> {
    await this.enter();
    try {
      return await fn(this);
    } finally {
      await this.exit();
    }
  }

  async auth(): Promise<void> {
    this.authed = await this.client.auth();
    if (this.authed) {
      logger.debug('Authed.');
    } else {
      logger.error('Auth failed.');
    }
  }

  /** Create or update a raw qBittorrent RSS auto-download rule. */
  async setRssRule(ruleName: string, rule: Record<string, unknown>): Promise<void> {
    if (!this.supports('can_rss_rules', 'set_rss_rule')) {
      return;
    }
    await this.client.rssSetRule!(ruleName, rule);
  }

  async getTorrentInfo(
    category: string | null = 'Bangumi',
    statusFilter: string | null = 'completed',
    tag: string | null = null,
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.supports('can_query', 'get_torrent_info')) {
      return [];
    }
    return this.client.torrentsInfo!(statusFilter, category, tag);
  }

  async getTorrentFiles(torrentHash: string): Promise<Array<Record<string, unknown>>> {
    if (!this.supports('can_query', 'get_torrent_files')) {
      return [];
    }
    return this.client.torrentsFiles!(torrentHash);
  }

  /**
   * Return task existence, or ``null`` when the backend cannot prove it.
   *
   * Destructive recovery paths must distinguish a confirmed absence from
   * a transient query failure; an empty bulk snapshot is not sufficient.
   */
  async torrentExists(torrentHash: string): Promise<boolean | null> {
    if (!this.supports('can_query', 'torrent_exists')) {
      return null;
    }
    return this.client.torrentExists!(torrentHash);
  }

  async renameTorrentFile(
    hash: string,
    oldPath: string,
    newPath: string,
    verify = true,
  ): Promise<RenameResult> {
    if (!this.supports('can_rename', 'rename_torrent_file')) {
      return new RenameResult(
        RenameOutcome.RETRYABLE_FAILURE,
        `${this.client.constructor.name} does not support file rename`,
      );
    }
    const rawResult = await this.client.torrentsRenameFile!(
      hash,
      oldPath,
      newPath,
      verify,
    );
    // Compatibility for test doubles and third-party clients that still
    // implement the pre-3.3.4 boolean contract.  Concrete built-in clients
    // all return RenameResult, and the facade always exposes RenameResult.
    let result: RenameResult;
    if (rawResult instanceof RenameResult) {
      result = rawResult;
    } else {
      result = new RenameResult(
        rawResult ? RenameOutcome.RENAMED : RenameOutcome.RETRYABLE_FAILURE,
        rawResult ? null : 'legacy downloader returned false',
      );
    }
    if (result.succeeded) {
      logger.log(`${oldPath} >> ${newPath}`);
    } else {
      logger.debug(`Rename ${result.outcome}: ${oldPath} >> ${newPath}`);
    }
    return result;
  }

  async deleteTorrent(hashes: string | string[], deleteFiles = true): Promise<boolean> {
    if (!this.supports('can_manage', 'delete_torrent')) {
      return false;
    }
    const ok = await this.client.torrentsDelete!(hashes, deleteFiles);
    if (ok) {
      logger.log('Remove torrents.');
    } else {
      logger.error('Failed to remove torrents.');
    }
    return ok;
  }

  async pauseTorrent(hashes: string | string[]): Promise<void> {
    if (!this.supports('can_manage', 'pause_torrent')) {
      return;
    }
    await this.client.torrentsPause!(hashes);
  }

  async resumeTorrent(hashes: string | string[]): Promise<void> {
    if (!this.supports('can_manage', 'resume_torrent')) {
      return;
    }
    await this.client.torrentsResume!(hashes);
  }

  /**
   * Download a torrent (or list of torrents) for the given bangumi entry.
   *
   * Handles both magnet links and .torrent file URLs, fetching file bytes
   * when necessary. Tags each torrent with ``ab:<bangumi_id>`` for later
   * episode-offset lookup during rename.
   *
   * 返回 AddResult，区分"新增成功 / 已添加过 / 投递失败"，
   * 调用方据此决定是否重试或发送失败通知。
   */
  async addTorrent(
    torrent: TorrentLike | TorrentLike[],
    bangumi: AddTorrentBangumi,
  ): Promise<AddResult> {
    if (!bangumi.save_path) {
      bangumi.save_path = genSavePath(bangumi);
    }
    let torrentUrl: string | string[] | null;
    let torrentFile: Buffer | Buffer[] | null;
    const req = new RequestContent();
    if (Array.isArray(torrent)) {
      if (torrent.length === 0) {
        logger.debug(`No torrent found: ${bangumi.official_title}`);
        return AddResult.FAILED;
      }
      if (torrent[0].url.includes('magnet')) {
        torrentUrl = torrent.map((t) => t.url);
        torrentFile = null;
      } else {
        torrentFile = await fetchTorrentFiles(req, torrent);
        if (!torrentFile.length) {
          logger.warn(`Failed to fetch torrent files for: ${bangumi.official_title}`);
          return AddResult.FAILED;
        }
        torrentUrl = null;
      }
    } else {
      if (torrent.url.includes('magnet')) {
        torrentUrl = torrent.url;
        torrentFile = null;
      } else {
        const content = await req.getContent(torrent.url);
        if (content === null) {
          logger.warn(`Failed to fetch torrent file for: ${bangumi.official_title}`);
          return AddResult.FAILED;
        }
        torrentFile = content;
        torrentUrl = null;
      }
    }
    // Create tag with bangumi_id for offset lookup during rename
    const tags = bangumi.id ? `ab:${bangumi.id}` : null;
    try {
      const result = await this.client.addTorrents(
        torrentUrl,
        torrentFile,
        bangumi.save_path,
        'Bangumi',
        tags,
      );
      if (result === AddResult.ADDED) {
        logger.debug(`Add torrent: ${bangumi.official_title}`);
        return AddResult.ADDED;
      }
      if (result === AddResult.DUPLICATE) {
        logger.debug(`Torrent added before: ${bangumi.official_title}`);
        return AddResult.DUPLICATE;
      }
      return AddResult.FAILED;
    } catch (e) {
      logger.error(`Failed to add torrent for ${bangumi.official_title}: ${errStr(e)}`);
      return AddResult.FAILED;
    }
  }

  async moveTorrent(hashes: string | string[], location: string): Promise<void> {
    if (!this.supports('can_manage', 'move_torrent')) {
      return;
    }
    await this.client.moveTorrent!(hashes, location);
  }

  async setCategory(hashes: string | string[], category: string): Promise<void> {
    if (!this.supports('can_manage', 'set_category')) {
      return;
    }
    await this.client.setCategory!(hashes, category);
  }

  /** Add a tag to a torrent. */
  async addTag(torrentHash: string, tag: string): Promise<void> {
    if (!this.supports('can_manage', 'add_tag')) {
      return;
    }
    await this.client.addTag!(torrentHash, tag);
    logger.debug(`Added tag '${tag}' to torrent ${torrentHash.slice(0, 8)}...`);
  }
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
