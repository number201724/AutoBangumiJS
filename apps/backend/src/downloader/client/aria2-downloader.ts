/**
 * aria2 JSON-RPC client — 1:1 port of module/downloader/client/aria2_downloader.py.
 *
 * httpx -> axios 映射说明：
 * - aria2 侧 Python 没有 verify=False（与 qB 不同），axios 默认验证证书，保持一致。
 * - httpx.Timeout(connect=3.1, read=10, write=10, pool=10) -> axios 整体超时 10s，
 *   单次调用可用 per-request timeout 覆盖（auth 期间的探测调用会传入更短的值）。
 * - asyncio.to_thread(...) -> 直接 await node:fs/promises（本身已是异步）。
 * - `async with Database() as db` -> 共享门面 `db`（better-sqlite3 同步单写者模型）。
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';

import { db } from '../../database/facade';
import type { Aria2RenameIntent } from '../../database/repos/aria2';
import {
  AddResult,
  type ConcreteDownloaderClient,
  type DownloaderCapabilities,
  RenameOutcome,
  RenameResult,
  sleep,
} from '../base';

const logger = new Logger('Aria2Downloader');

// 每次 JSON-RPC 调用的默认超时（秒），auth() 期间的探测调用会传入更短的值。
const DEFAULT_CALL_TIMEOUT = 10.0;

// qBittorrent 风格 status_filter -> aria2 status 集合的映射。null（不过滤）
// 之外的未知取值一律当作"不过滤"处理，而不是返回空列表。
const STATUS_FILTER_MAP: Record<string, Set<string>> = {
  completed: new Set(['complete']),
  downloading: new Set(['active']),
  active: new Set(['active']),
  paused: new Set(['paused']),
  errored: new Set(['error']),
};

/**
 * aria2 status -> qB 状态词汇。WebUI 的状态徽标/文案只认 qB 的取值，
 * 直接透传 aria2 原词会显示未翻译的原始字符串。
 */
function mapQbState(aria2Status: string, finished: boolean): string {
  if (aria2Status === 'active') {
    return finished ? 'uploading' : 'downloading';
  }
  if (aria2Status === 'waiting') {
    return finished ? 'queuedUP' : 'queuedDL';
  }
  if (aria2Status === 'paused') {
    return finished ? 'pausedUP' : 'pausedDL';
  }
  if (aria2Status === 'complete') {
    return 'pausedUP';
  }
  if (aria2Status === 'error' || aria2Status === 'removed') {
    return 'error';
  }
  return aria2Status;
}

/** aria2 JSON-RPC 返回的业务错误（服务器收到了请求，但拒绝执行）。 */
export class Aria2RpcError extends Error {
  /** Python 端 e.message 的等价物（TS Error.message 是包装后的完整串）。 */
  readonly rpcMessage: string;

  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(`aria2 RPC error ${code}: ${message}`);
    this.name = 'Aria2RpcError';
    this.rpcMessage = message;
  }
}

/** 请求根本没有得到 aria2 服务器的有效响应（网络/超时/JSON 解析失败）。 */
export class Aria2ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Aria2ConnectionError';
  }
}

/** Python FileExistsError 等价物：_moveFile 拒绝覆盖时抛出。 */
class FileExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileExistsError';
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** os.path.exists 的异步等价物。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * os.path.normpath 的等价物。node:path.normalize 会保留尾部分隔符，
 * os.path.normpath 不会——比较前统一剥掉（根目录除外）。
 */
function normPath(p: string): string {
  let n = path.normalize(p);
  while (n.length > 1 && (n.endsWith('/') || n.endsWith('\\'))) {
    n = n.slice(0, -1);
  }
  return n;
}

/** os.path.samefile：比较 dev + ino。 */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([
    fsp.stat(a, { bigint: true }),
    fsp.stat(b, { bigint: true }),
  ]);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

/** shutil.move：rename 失败（跨设备 EXDEV）时退化为 copy + unlink。 */
async function moveAcrossDevices(oldAbs: string, newAbs: string): Promise<void> {
  try {
    await fsp.rename(oldAbs, newAbs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
      await fsp.copyFile(oldAbs, newAbs);
      await fsp.unlink(oldAbs);
      return;
    }
    throw e;
  }
}

/**
 * os.path.commonpath([boundary, p]) == boundary 的等价物
 * （Python 在不同盘符时抛 ValueError -> false）。
 */
function isWithinDir(boundary: string, p: string): boolean {
  const rel = path.relative(boundary, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** aria2 的数值字段全是字符串（"0" 也是 truthy），统一转 int。 */
function aria2Int(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** fsp.stat(..., { bigint: true }) 返回值的形状（BigInt -> Number 在调用处做）。 */
interface BigIntStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

export class Aria2Downloader implements ConcreteDownloaderClient {
  // aria2 通过 JSON-RPC 暴露真实的查询/重命名/管理能力（tellActive/tellFiles/
  // changeOption 等），只是没有 qBittorrent 原生的 RSS 规则功能，因此
  // can_rss_rules 保持 False，其余按真实支持情况置 True。
  readonly capabilities: DownloaderCapabilities = {
    can_query: true,
    can_rename: true,
    can_manage: true,
    can_rss_rules: false,
  };

  private readonly host: string;
  private readonly secret: string;
  private client: AxiosInstance | null = null;
  private authed = false;
  private readonly rpcUrl: string;
  private id = 0;

  constructor(host: string, username: string, password: string) {
    void username; // aria2 只用 token:secret（password），username 仅保持签名一致
    this.host = host;
    this.secret = password;
    this.rpcUrl = `${host}/jsonrpc`;
  }

  private newClient(): AxiosInstance {
    return axios.create({
      timeout: 10_000,
      maxRedirects: 0,  // httpx 默认不跟随重定向
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: (d) => d,
    });
  }

  private async call<T = unknown>(
    method: string,
    params: unknown[] | null = null,
    timeout: number = DEFAULT_CALL_TIMEOUT,
  ): Promise<T> {
    if (this.client === null) {
      throw new Error('Aria2Downloader.auth() must run first');
    }
    this.id += 1;
    const fullParams = [`token:${this.secret}`, ...(params ?? [])];
    const payload = {
      jsonrpc: '2.0',
      id: this.id,
      method: `aria2.${method}`,
      params: fullParams,
    };
    let resp: AxiosResponse;
    try {
      resp = await this.client.post(this.rpcUrl, JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
        timeout: timeout * 1000,
      });
    } catch (e) {
      if (axios.isAxiosError(e) && e.code === 'ECONNABORTED') {
        throw new Aria2ConnectionError(`aria2 RPC '${method}' timed out: ${errMsg(e)}`);
      }
      throw new Aria2ConnectionError(`aria2 RPC '${method}' request failed: ${errMsg(e)}`);
    }
    let result: unknown;
    try {
      const text = typeof resp.data === 'string' ? resp.data : String(resp.data ?? '');
      result = JSON.parse(text);
    } catch (e) {
      throw new Aria2ConnectionError(
        `aria2 RPC '${method}' returned invalid JSON: ${errMsg(e)}`,
      );
    }
    if (result !== null && typeof result === 'object' && 'error' in result) {
      const err = ((result as Record<string, unknown>)['error'] ?? {}) as Record<
        string,
        unknown
      >;
      throw new Aria2RpcError(
        (err['code'] as number | null) ?? null,
        (err['message'] as string) ?? String(err),
      );
    }
    return (result as Record<string, unknown>)['result'] as T;
  }

  async auth(retry = 3): Promise<boolean> {
    if (this.client !== null && this.authed) {
      return true;
    }
    if (this.client === null) {
      this.client = this.newClient();
    }
    let times = 0;
    while (times < retry) {
      try {
        await this.call('getVersion');
        this.authed = true;
        return true;
      } catch (e) {
        if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
          logger.warn(
            `Can't login Aria2 Server ${this.host}, retry in 5 seconds. Error: ${errMsg(e)}`,
          );
          await sleep(5);
          times += 1;
          continue;
        }
        throw e;
      }
    }
    return false;
  }

  async logout(): Promise<void> {
    this.authed = false;
    if (this.client) {
      // axios 没有 aclose()；默认全局 agent 不归本实例所有，直接丢弃引用即可
      this.client = null;
    }
  }

  async checkConnection(): Promise<string> {
    const version = (await this.call<Record<string, string> | null>('getVersion')) ?? {};
    return version['version'] ?? 'unknown';
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private static normalizeHashes(hashes: string | string[]): string[] {
    if (Array.isArray(hashes)) {
      return [...hashes];
    }
    return hashes.includes('|') ? hashes.split('|') : [hashes];
  }

  /** 从 'ab:<id>' 格式的 tag/tags 中解出 bangumi_id（与 Renamer 的约定一致）。 */
  private static parseBangumiIdFromTag(tags: string | null | undefined): number | null {
    if (!tags) {
      return null;
    }
    for (let tag of tags.split(',')) {
      tag = tag.trim();
      if (tag.startsWith('ab:')) {
        // Python int() 严格（'12a'/'12.5' 抛 ValueError 跳过该 tag）
        const rest = tag.slice(3);
        if (/^-?\d+$/.test(rest)) {
          return parseInt(rest, 10);
        }
      }
    }
    return null;
  }

  private static isDuplicateError(e: Aria2RpcError): boolean {
    const msg = e.rpcMessage.toLowerCase();
    return msg.includes('already') || msg.includes('duplicate');
  }

  private static isNotFoundError(e: Aria2RpcError): boolean {
    const msg = e.rpcMessage.toLowerCase();
    return msg.includes('not found') || msg.includes('is not found');
  }

  private static extractName(download: Record<string, any>): string {
    const btInfo = ((download['bittorrent'] ?? {}) as Record<string, any>)['info'] ?? {};
    if (btInfo['name']) {
      return btInfo['name'] as string;
    }
    const files = (download['files'] ?? []) as Array<Record<string, any>>;
    if (files.length && files[0]['path']) {
      return path.basename(files[0]['path'] as string);
    }
    return (download['gid'] as string) ?? '';
  }

  private static extractFollowedByGid(status: unknown): string | null {
    if (status === null || typeof status !== 'object') {
      return null;
    }
    const followedBy = ((status as Record<string, unknown>)['followedBy'] ?? []) as unknown;
    if (Array.isArray(followedBy) && followedBy.length) {
      return String(followedBy[0]);
    }
    return null;
  }

  private static translateRenamedPath(
    p: string,
    renamedPaths: Record<string, string>,
  ): string {
    const seen = new Set<string>();
    while (p in renamedPaths && !seen.has(p)) {
      seen.add(p);
      p = renamedPaths[p];
    }
    return p;
  }

  /**
   * 移动单个文件；目标已存在且不是同一个文件时拒绝覆盖。
   *
   * 多文件种子若映射到同一目标名，直接覆盖会毁掉已重命名好的文件，
   * 所以这里显式拦下来。
   */
  private static async moveFile(oldAbs: string, newAbs: string): Promise<void> {
    const oldExists = await pathExists(oldAbs);
    const newExists = await pathExists(newAbs);
    if (oldExists && newExists && (await sameFile(oldAbs, newAbs))) {
      return;
    }
    if (newExists && !(oldExists && (await sameFile(oldAbs, newAbs)))) {
      throw new FileExistsError(`destination already exists: ${newAbs}`);
    }
    await fsp.mkdir(path.dirname(newAbs), { recursive: true });
    await moveAcrossDevices(oldAbs, newAbs);
  }

  private static renameIntentFromStat(
    oldPath: string,
    newPath: string,
    sourceStat: BigIntStat,
  ): Aria2RenameIntent {
    return {
      old_path: oldPath,
      new_path: newPath,
      // JSON 里按字符串存（mtime_ns 超 2^53，见 repos/aria2.ts）
      st_dev: String(sourceStat.dev),
      st_ino: String(sourceStat.ino),
      st_size: String(sourceStat.size),
      st_mtime_ns: String(sourceStat.mtimeNs),
    };
  }

  private static intentMatchesStat(intent: Aria2RenameIntent, targetStat: BigIntStat): boolean {
    return (
      BigInt(intent.st_dev) === targetStat.dev &&
      BigInt(intent.st_ino) === targetStat.ino &&
      BigInt(intent.st_size) === targetStat.size &&
      BigInt(intent.st_mtime_ns) === targetStat.mtimeNs
    );
  }

  private static async moveFiles(
    files: Array<Record<string, any>>,
    oldDir: string,
    newDir: string,
  ): Promise<void> {
    const normOldDir = normPath(oldDir);
    for (const f of files) {
      const p = f['path'] as string | undefined;
      if (!p || !(await pathExists(p))) {
        continue;
      }
      const rel = path.relative(normOldDir, p);
      const dest = path.join(newDir, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await moveAcrossDevices(p, dest);
    }
  }

  /**
   * 删除单个文件，并向上清理变空的父目录，直到 boundary（含）为止不再删除。
   *
   * boundary 通常是 aria2 的 ``dir``（bangumi 的 season 目录），可能被多个
   * gid 共享，所以绝不删除 boundary 本身或它之外的目录。
   */
  private static async removeFileAndEmptyDirs(p: string, boundary: string): Promise<void> {
    if (await pathExists(p)) {
      await fsp.unlink(p);
    }
    const normBoundary = normPath(boundary);
    let parent = path.dirname(p);
    while (
      normPath(parent) !== normBoundary &&
      normPath(parent).startsWith(normBoundary + path.sep)
    ) {
      try {
        await fsp.rmdir(parent);
      } catch {
        break;
      }
      parent = path.dirname(parent);
    }
  }

  // ------------------------------------------------------------------
  // Adding
  // ------------------------------------------------------------------

  /**
   * dedup 命中后校验 gid 是否仍存在于 aria2；陈旧则删记录并返回 true。
   *
   * 本地 aria2_gid 表可能和 aria2 真实状态脱节（用户在 aria2 UI 里删了
   * 任务、或 aria2 没开 --save-session 就重启了），不校验的话陈旧记录
   * 会让同一个种子永远被当作"已添加"而无法重新下载。
   *
   * - RPC 报 not found、或 status 为 "removed" → 记录陈旧，删掉，返回 true；
   * - aria2 不可达（连接错误）→ 无法断言，保守保留记录，返回 null；
   * - 其余 RPC 错误 → 同样保守保留，返回 null。
   */
  private async dedupRecordIsStale(gid: string): Promise<boolean | null> {
    let status: Record<string, any> | null;
    try {
      status = await this.call<Record<string, any> | null>('tellStatus', [gid, ['status']]);
    } catch (e) {
      if (e instanceof Aria2RpcError) {
        if (Aria2Downloader.isNotFoundError(e)) {
          logger.log(`Stale dedup record: gid ${gid} no longer exists, removing and re-adding`);
          db.aria2.delete(gid);
          return true;
        }
        logger.debug(`Cannot verify gid ${gid}, keeping record: ${errMsg(e)}`);
        return null;
      }
      if (e instanceof Aria2ConnectionError) {
        // aria2 不可达 != 记录陈旧，绝不能因此删本地记录。
        logger.debug(`aria2 unreachable while verifying gid ${gid}, keeping record: ${errMsg(e)}`);
        return null;
      }
      throw e;
    }
    if ((status ?? {})['status'] === 'removed') {
      logger.log(
        `Stale dedup record: gid ${gid} was removed in aria2, removing and re-adding`,
      );
      db.aria2.delete(gid);
      return true;
    }
    return false;
  }

  private async addUri(
    url: string,
    options: Record<string, unknown>,
  ): Promise<[AddResult, string | null]> {
    try {
      const gid = await this.call<string>('addUri', [[url], options]);
      return [AddResult.ADDED, gid];
    } catch (e) {
      if (e instanceof Aria2RpcError) {
        if (Aria2Downloader.isDuplicateError(e)) {
          logger.debug(`addUri reports duplicate: ${e.rpcMessage}`);
          return [AddResult.DUPLICATE, null];
        }
        logger.error(`addUri failed for ${url}: ${errMsg(e)}`);
        return [AddResult.FAILED, null];
      }
      if (e instanceof Aria2ConnectionError) {
        logger.error(`addUri connection error for ${url}: ${errMsg(e)}`);
        return [AddResult.FAILED, null];
      }
      throw e;
    }
  }

  private async addTorrentFile(
    data: Buffer,
    options: Record<string, unknown>,
  ): Promise<[AddResult, string | null]> {
    const b64 = data.toString('base64');
    try {
      const gid = await this.call<string>('addTorrent', [b64, [], options]);
      return [AddResult.ADDED, gid];
    } catch (e) {
      if (e instanceof Aria2RpcError) {
        if (Aria2Downloader.isDuplicateError(e)) {
          logger.debug(`addTorrent reports duplicate: ${e.rpcMessage}`);
          return [AddResult.DUPLICATE, null];
        }
        logger.error(`addTorrent failed: ${errMsg(e)}`);
        return [AddResult.FAILED, null];
      }
      if (e instanceof Aria2ConnectionError) {
        logger.error(`addTorrent connection error: ${errMsg(e)}`);
        return [AddResult.FAILED, null];
      }
      throw e;
    }
  }

  private async resolveFollowedByGid(gid: string): Promise<string> {
    let status: unknown;
    try {
      status = await this.call('tellStatus', [gid, ['followedBy']]);
    } catch (e) {
      if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
        logger.debug(`Could not resolve followedBy for ${gid}: ${errMsg(e)}`);
        return gid;
      }
      throw e;
    }
    return Aria2Downloader.extractFollowedByGid(status) ?? gid;
  }

  /**
   * 添加下载任务，返回新增/重复/失败的三态结果。
   *
   * 去重优先靠本地的 dedup_key（url 或种子内容 hash）判断"已经添加过"，
   * aria2 RPC 报错里带 already/duplicate 字样时也当作重复处理（见
   * ``isDuplicateError``）——这样调用方（DownloadClient.addTorrent）
   * 才能像 qBittorrent 一样区分"新增成功"和"之前加过了"。
   */
  async addTorrents(
    torrentUrls: string | string[] | null,
    torrentFiles: Buffer | Buffer[] | null,
    savePath: string,
    category: string,
    tags: string | null = null,
  ): Promise<AddResult> {
    const bangumiId = Aria2Downloader.parseBangumiIdFromTag(tags);
    const options = { dir: savePath };
    let addedAny = false;
    let duplicateAny = false;
    let failedAny = false;
    if (torrentUrls) {
      const urls = Array.isArray(torrentUrls) ? torrentUrls : [torrentUrls];
      for (const url of urls) {
        const dedupKey = `url:${url}`;
        const existingGid = db.aria2.findByDedupKey(dedupKey);
        if (existingGid) {
          const stale = await this.dedupRecordIsStale(existingGid);
          if (stale === null) {
            failedAny = true;
            continue;
          }
          if (!stale) {
            logger.debug(`Skip already-added url: ${url}`);
            duplicateAny = true;
            continue;
          }
        }
        const [result, gid0] = await this.addUri(url, options);
        if (result === AddResult.DUPLICATE) {
          duplicateAny = true;
          continue;
        }
        if (result === AddResult.FAILED || gid0 === null) {
          failedAny = true;
          continue;
        }
        const gid = await this.resolveFollowedByGid(gid0);
        db.aria2.upsert(gid, { bangumi_id: bangumiId, category, dedup_key: dedupKey });
        addedAny = true;
      }
    }
    if (torrentFiles) {
      const files = Array.isArray(torrentFiles) ? torrentFiles : [torrentFiles];
      for (const f of files) {
        const dedupKey = `file:${createHash('sha1').update(f).digest('hex')}`;
        const existingGid = db.aria2.findByDedupKey(dedupKey);
        if (existingGid) {
          const stale = await this.dedupRecordIsStale(existingGid);
          if (stale === null) {
            failedAny = true;
            continue;
          }
          if (!stale) {
            logger.debug('Skip already-added torrent file');
            duplicateAny = true;
            continue;
          }
        }
        const [result, gid0] = await this.addTorrentFile(f, options);
        if (result === AddResult.DUPLICATE) {
          duplicateAny = true;
          continue;
        }
        if (result === AddResult.FAILED || gid0 === null) {
          failedAny = true;
          continue;
        }
        const gid = await this.resolveFollowedByGid(gid0);
        db.aria2.upsert(gid, { bangumi_id: bangumiId, category, dedup_key: dedupKey });
        addedAny = true;
      }
    }
    // 部分成功按 ADDED 报告（与 qB 的批量语义一致）：已经真正开始下载
    // 的任务必须让上层入库，否则会与 aria2 状态脱节；全部失败才算 FAILED。
    if (addedAny) {
      return AddResult.ADDED;
    }
    if (failedAny) {
      return AddResult.FAILED;
    }
    if (duplicateAny) {
      return AddResult.DUPLICATE;
    }
    return AddResult.FAILED;
  }

  // ------------------------------------------------------------------
  // Querying
  // ------------------------------------------------------------------

  async torrentsInfo(
    statusFilter: string | null,
    category: string | null,
    tag: string | null = null,
  ): Promise<Array<Record<string, unknown>>> {
    let raw: Array<Record<string, any>>;
    try {
      const active = (await this.call<Array<Record<string, any>> | null>('tellActive')) ?? [];
      const waiting =
        (await this.call<Array<Record<string, any>> | null>('tellWaiting', [0, 1000])) ?? [];
      const stopped =
        (await this.call<Array<Record<string, any>> | null>('tellStopped', [0, 1000])) ?? [];
      raw = [...active, ...waiting, ...stopped];
    } catch (e) {
      if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
        logger.error(`Failed to query downloads: ${errMsg(e)}`);
        throw e;
      }
      throw e;
    }
    const followedBy = new Map<string, string>();
    for (const d of raw) {
      const gid = d['gid'] as string | undefined;
      const follower = Aria2Downloader.extractFollowedByGid(d);
      if (gid && follower) {
        followedBy.set(gid, follower);
      }
    }
    const gids = raw
      .filter((d) => d['gid'])
      .map((d) => followedBy.get(d['gid'] as string) ?? (d['gid'] as string));
    for (const [oldGid, newGid] of followedBy) {
      db.aria2.replaceGid(oldGid, newGid);
    }
    const meta = db.aria2.getMany(gids);

    const allowedStatuses = statusFilter ? STATUS_FILTER_MAP[statusFilter] : undefined;
    const result: Array<Record<string, unknown>> = [];
    for (const d of raw) {
      const gid = (d['gid'] as string) ?? '';
      const aria2Status = (d['status'] as string) ?? '';
      if (followedBy.has(gid)) {
        // 磁力元数据 stub：真实下载由 followedBy gid 表示。stub 的
        // status 是 "complete"，若不跳过会以完成态混进结果，让
        // 重命名循环拿元数据文件当正片处理，且 UI 出现重复条目。
        continue;
      }
      if (allowedStatuses !== undefined && !allowedStatuses.has(aria2Status)) {
        continue;
      }
      const info = meta.get(followedBy.get(gid) ?? gid);
      const torrentCategory = info ? info.category : null;
      if (category && torrentCategory !== category) {
        continue;
      }
      const tagsStr = info && info.bangumi_id ? `ab:${info.bangumi_id}` : '';
      if (tag && tag !== tagsStr) {
        continue;
      }
      // aria2 JSON-RPC 的数值字段全是字符串（"0" 也是 truthy），必须先
      // 转 int 再判断，否则磁力链拉元数据阶段 totalLength "0" 会除零。
      const total = aria2Int(d['totalLength']);
      const completed = aria2Int(d['completedLength']);
      const dlspeed = aria2Int(d['downloadSpeed']);
      const numSeeds = aria2Int(d['numSeeders']);
      const connections = aria2Int(d['connections']);
      const finished = total > 0 && completed >= total;
      // ETA 沿 qB 约定：8640000 = 未知/无穷（UI 渲染为 "-"）。
      let eta: number;
      if (finished) {
        eta = 0;
      } else if (dlspeed > 0 && total > 0) {
        eta = Math.floor((total - completed) / dlspeed);
      } else {
        eta = 8640000;
      }
      // aria2 不记录添加时间；用本地 gid 映射的入库时间近似
      // （UI 按 added_on 排序），无记录时归 0 排到最后。
      // Python 语义（含其 quirk）：对 naive datetime 调 .timestamp() 按宿主机
      // 本地时区解释——存储值是 UTC 墙钟文本，这里同样按本地时区求值
      const createdAt = info && info.created_at ? parseStoredTimeAsLocal(info.created_at) : null;
      result.push({
        hash: gid,
        name: Aria2Downloader.extractName(d),
        save_path: (d['dir'] as string) ?? '',
        tags: tagsStr,
        category: torrentCategory ?? '',
        state: mapQbState(aria2Status, finished),
        size: total,
        progress: total > 0 ? completed / total : 0.0,
        dlspeed,
        upspeed: aria2Int(d['uploadSpeed']),
        num_seeds: numSeeds,
        // qB 的 num_leechs ≈ 非做种连接数；aria2 只报连接总数。
        num_leechs: Math.max(connections - numSeeds, 0),
        eta,
        added_on: createdAt ? Math.floor(createdAt.getTime() / 1000) : 0,
      });
    }
    return result;
  }

  /** Return False only when aria2 explicitly confirms a gid is absent. */
  async torrentExists(gid: string): Promise<boolean | null> {
    try {
      await this.call('tellStatus', [gid, ['status']]);
    } catch (e) {
      if (e instanceof Aria2RpcError) {
        if (Aria2Downloader.isNotFoundError(e)) {
          return false;
        }
        logger.warn(`Cannot confirm whether aria2 gid ${gid} exists: ${errMsg(e)}`);
        return null;
      }
      if (e instanceof Aria2ConnectionError) {
        logger.warn(`Cannot confirm whether aria2 gid ${gid} exists: ${errMsg(e)}`);
        return null;
      }
      throw e;
    }
    return true;
  }

  async torrentsFiles(torrentHash: string): Promise<Array<Record<string, unknown>>> {
    let files: Array<Record<string, any>> | null;
    try {
      files = await this.call<Array<Record<string, any>> | null>('getFiles', [torrentHash]);
    } catch (e) {
      if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
        logger.error(`Failed to get files for ${torrentHash}: ${errMsg(e)}`);
        return [];
      }
      throw e;
    }
    let saveDir = '';
    try {
      const status = await this.call<Record<string, any> | null>('tellStatus', [
        torrentHash,
        ['dir'],
      ]);
      saveDir = ((status ?? {})['dir'] as string) ?? '';
    } catch (e) {
      if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
        logger.debug(`Could not resolve dir for ${torrentHash}: ${errMsg(e)}`);
      } else {
        throw e;
      }
    }
    const renamedPaths = db.aria2.getRenamedPaths(torrentHash);
    const result: Array<Record<string, unknown>> = [];
    for (const f of files ?? []) {
      const p = (f['path'] as string) ?? '';
      let rel = saveDir && p ? path.relative(saveDir, p) : p;
      rel = Aria2Downloader.translateRenamedPath(rel, renamedPaths);
      result.push({ name: rel, size: aria2Int(f['length']) });
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Rename (filesystem move -- aria2 downloads land in a known local dir)
  // ------------------------------------------------------------------

  async torrentsRenameFile(
    torrentHash: string,
    oldPath: string,
    newPath: string,
    verify = true,
  ): Promise<RenameResult> {
    void verify; // 文件系统重命名自带 stat 验证，参数仅为接口对齐
    let status: Record<string, any> | null;
    try {
      status = await this.call<Record<string, any> | null>('tellStatus', [
        torrentHash,
        ['dir'],
      ]);
    } catch (e) {
      if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
        logger.warn(`Rename failed, cannot resolve save dir for ${torrentHash}: ${errMsg(e)}`);
        return new RenameResult(RenameOutcome.RETRYABLE_FAILURE, errMsg(e));
      }
      throw e;
    }
    const saveDir = ((status ?? {})['dir'] as string) ?? '';
    if (!saveDir) {
      return new RenameResult(
        RenameOutcome.RETRYABLE_FAILURE,
        'aria2 returned no download directory',
      );
    }
    const oldAbs = path.join(saveDir, oldPath);
    const newAbs = path.join(saveDir, newPath);
    const [oldExists, newExists] = await Promise.all([pathExists(oldAbs), pathExists(newAbs)]);
    const persistedIntent = db.aria2.getRenameIntent(torrentHash);

    if (!oldExists) {
      const matchingIntent =
        persistedIntent !== null &&
        persistedIntent.old_path === oldPath &&
        persistedIntent.new_path === newPath
          ? persistedIntent
          : null;
      if (!newExists) {
        if (matchingIntent !== null) {
          db.aria2.clearRenameIntent(torrentHash, matchingIntent);
        }
        return new RenameResult(
          RenameOutcome.RETRYABLE_FAILURE,
          `rename source is missing: ${oldAbs}`,
        );
      }
      if (matchingIntent === null) {
        return new RenameResult(
          RenameOutcome.DESTINATION_EXISTS,
          'destination exists without a matching durable rename ' + `intent: ${newAbs}`,
        );
      }
      let targetStat: BigIntStat;
      try {
        targetStat = await fsp.stat(newAbs, { bigint: true });
      } catch (e) {
        return new RenameResult(RenameOutcome.RETRYABLE_FAILURE, errMsg(e));
      }
      if (!Aria2Downloader.intentMatchesStat(matchingIntent, targetStat)) {
        db.aria2.clearRenameIntent(torrentHash, matchingIntent);
        return new RenameResult(
          RenameOutcome.DESTINATION_EXISTS,
          `destination does not match durable rename intent: ${newAbs}`,
        );
      }
      const finalized = db.aria2.finalizeRenameIntent(torrentHash, matchingIntent);
      if (!finalized) {
        return new RenameResult(
          RenameOutcome.RETRYABLE_FAILURE,
          'durable rename intent changed before recovery commit',
        );
      }
      return new RenameResult(RenameOutcome.ALREADY_APPLIED);
    }

    let sourceStat: BigIntStat;
    try {
      sourceStat = await fsp.stat(oldAbs, { bigint: true });
    } catch (e) {
      return new RenameResult(RenameOutcome.RETRYABLE_FAILURE, errMsg(e));
    }
    const intent = Aria2Downloader.renameIntentFromStat(oldPath, newPath, sourceStat);
    db.aria2.setRenameIntent(torrentHash, intent);
    try {
      await Aria2Downloader.moveFile(oldAbs, newAbs);
    } catch (e) {
      db.aria2.clearRenameIntent(torrentHash, intent);
      if (e instanceof FileExistsError) {
        logger.warn(
          `Refusing to overwrite existing file ${newAbs}, rename of ${oldAbs} skipped`,
        );
        return new RenameResult(
          RenameOutcome.DESTINATION_EXISTS,
          `destination already exists: ${newAbs}`,
        );
      }
      // OSError 等价物（Node system error）
      logger.warn(`Failed to rename file ${oldAbs} -> ${newAbs}: ${errMsg(e)}`);
      return new RenameResult(RenameOutcome.RETRYABLE_FAILURE, errMsg(e));
    }
    let targetStat: BigIntStat;
    try {
      targetStat = await fsp.stat(newAbs, { bigint: true });
    } catch (e) {
      logger.debug(`Rename reported success but ${newAbs} cannot be verified`);
      // Keep the intent: the move may have completed and a later retry can
      // still reconcile it if the target becomes visible.
      return new RenameResult(RenameOutcome.RETRYABLE_FAILURE, errMsg(e));
    }
    if (!Aria2Downloader.intentMatchesStat(intent, targetStat)) {
      db.aria2.clearRenameIntent(torrentHash, intent);
      return new RenameResult(
        RenameOutcome.DESTINATION_EXISTS,
        `renamed target identity changed unexpectedly: ${newAbs}`,
      );
    }
    const finalized = db.aria2.finalizeRenameIntent(torrentHash, intent);
    if (!finalized) {
      return new RenameResult(
        RenameOutcome.RETRYABLE_FAILURE,
        'durable rename intent changed before sidecar commit',
      );
    }
    return new RenameResult(RenameOutcome.RENAMED);
  }

  // ------------------------------------------------------------------
  // Management
  // ------------------------------------------------------------------

  async torrentsDelete(hash: string | string[], deleteFiles = true): Promise<boolean> {
    const gids = Aria2Downloader.normalizeHashes(hash);
    let ok = true;
    for (const gid of gids) {
      if (deleteFiles) {
        let saveDir: string;
        let files: Array<Record<string, any>> | null;
        try {
          const status = await this.call<Record<string, any> | null>('tellStatus', [
            gid,
            ['dir'],
          ]);
          saveDir = (status ?? {})['dir'] as string;
          if (!saveDir) {
            throw new Aria2ConnectionError(`aria2 returned no download directory for ${gid}`);
          }
          files = await this.call<Array<Record<string, any>> | null>('getFiles', [gid]);
        } catch (e) {
          if (e instanceof Aria2RpcError) {
            if (Aria2Downloader.isNotFoundError(e)) {
              // The task disappeared after a previous successful
              // cleanup (or was removed externally).  There is no
              // downloader-owned file list left to resolve.
              db.aria2.delete(gid);
              continue;
            }
            logger.warn(`Cannot safely delete current files for ${gid}: ${errMsg(e)}`);
            ok = false;
            continue;
          }
          if (e instanceof Aria2ConnectionError) {
            // If the current paths cannot be enumerated safely, do
            // not remove the task or its sidecar.  A later retry can
            // still reconcile the staged files.
            logger.warn(`Cannot safely delete current files for ${gid}: ${errMsg(e)}`);
            ok = false;
            continue;
          }
          throw e;
        }

        const renamedPaths = db.aria2.getRenamedPaths(gid);
        let filesRemoved = true;
        for (const f of files ?? []) {
          const rawPath = f['path'] as string | undefined;
          if (!rawPath) {
            continue;
          }
          const relativePath = path.relative(saveDir, rawPath);
          const currentRelativePath = Aria2Downloader.translateRenamedPath(
            relativePath,
            renamedPaths,
          );
          const currentPath = normPath(path.join(saveDir, currentRelativePath));
          const boundary = normPath(saveDir);
          const withinBoundary = isWithinDir(boundary, currentPath);
          if (!withinBoundary) {
            logger.warn(`Refusing to delete aria2 path outside save dir: ${currentPath}`);
            filesRemoved = false;
            continue;
          }
          try {
            await Aria2Downloader.removeFileAndEmptyDirs(currentPath, saveDir);
          } catch (e) {
            logger.warn(`Failed to delete current file ${currentPath}: ${errMsg(e)}`);
            filesRemoved = false;
          }
        }
        if (!filesRemoved) {
          ok = false;
          continue;
        }
      }

      let removed = false;
      try {
        await this.call('forceRemove', [gid]);
        removed = true;
      } catch (e) {
        if (e instanceof Aria2RpcError) {
          if (Aria2Downloader.isNotFoundError(e)) {
            removed = true;
          } else {
            logger.error(`Failed to remove ${gid}: ${errMsg(e)}`);
            ok = false;
          }
        } else if (e instanceof Aria2ConnectionError) {
          logger.error(`Failed to remove ${gid}: ${errMsg(e)}`);
          ok = false;
        } else {
          throw e;
        }
      }

      // The local mapping is recovery state.  Keep it whenever aria2
      // may still own the task; delete only after confirmed removal
      // or an explicit not-found response.
      if (removed) {
        db.aria2.delete(gid);
      }
    }
    return ok;
  }

  async torrentsPause(hashes: string | string[]): Promise<void> {
    for (const gid of Aria2Downloader.normalizeHashes(hashes)) {
      try {
        await this.call('forcePause', [gid]);
      } catch (e) {
        if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
          logger.warn(`Failed to pause ${gid}: ${errMsg(e)}`);
          continue;
        }
        throw e;
      }
    }
  }

  async torrentsResume(hashes: string | string[]): Promise<void> {
    for (const gid of Aria2Downloader.normalizeHashes(hashes)) {
      try {
        await this.call('unpause', [gid]);
      } catch (e) {
        if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
          logger.warn(`Failed to resume ${gid}: ${errMsg(e)}`);
          continue;
        }
        throw e;
      }
    }
  }

  async moveTorrent(hashes: string | string[], newLocation: string): Promise<void> {
    for (const gid of Aria2Downloader.normalizeHashes(hashes)) {
      let status: Record<string, any> | null;
      try {
        status = await this.call<Record<string, any> | null>('tellStatus', [gid, ['dir']]);
      } catch (e) {
        if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
          logger.warn(`Cannot move ${gid}, status lookup failed: ${errMsg(e)}`);
          continue;
        }
        throw e;
      }
      const oldDir = (status ?? {})['dir'] as string | undefined;
      if (!oldDir || normPath(oldDir) === normPath(newLocation)) {
        continue;
      }
      let files: Array<Record<string, any>> | null;
      try {
        files = await this.call<Array<Record<string, any>> | null>('getFiles', [gid]);
      } catch (e) {
        if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
          logger.warn(`Cannot move ${gid}, file list failed: ${errMsg(e)}`);
          continue;
        }
        throw e;
      }
      try {
        await Aria2Downloader.moveFiles(files ?? [], oldDir, newLocation);
      } catch (e) {
        // OSError 等价物（Node system error）
        logger.warn(`Failed to move files for ${gid}: ${errMsg(e)}`);
        continue;
      }
      try {
        await this.call('changeOption', [gid, { dir: newLocation }]);
      } catch (e) {
        if (e instanceof Aria2RpcError || e instanceof Aria2ConnectionError) {
          logger.debug(`changeOption dir failed for ${gid} (non-fatal): ${errMsg(e)}`);
        } else {
          throw e;
        }
      }
    }
  }

  async setCategory(hash: string | string[], category: string): Promise<void> {
    for (const gid of Aria2Downloader.normalizeHashes(hash)) {
      db.aria2.setCategory(gid, category);
    }
  }

  /** 只认识 'ab:<bangumi_id>' 格式的 tag（用于 offset 关联），其余忽略。 */
  async addTag(hash: string, tag: string): Promise<void> {
    const bangumiId = Aria2Downloader.parseBangumiIdFromTag(tag);
    if (bangumiId === null) {
      logger.debug(`Ignoring unsupported tag: ${tag}`);
      return;
    }
    db.aria2.upsert(hash, { bangumi_id: bangumiId });
  }
}

/** Python naive datetime .timestamp() 语义：把 'YYYY-MM-DD HH:MM:SS[.ffffff]'
 * 按宿主机本地时区解释（不解析时区后缀）。 */
function parseStoredTimeAsLocal(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return null;
  const ms = m[7] ? Math.floor(parseInt(m[7].padEnd(6, '0').slice(0, 6), 10) / 1000) : 0;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  return Number.isNaN(d.getTime()) ? null : d;
}
