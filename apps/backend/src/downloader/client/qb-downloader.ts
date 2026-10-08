/**
 * qBittorrent API v2 client — 1:1 port of module/downloader/client/qb_downloader.py.
 *
 * httpx -> axios 映射说明：
 * - httpx.AsyncClient(verify=False) -> httpsAgent: new https.Agent({ rejectUnauthorized: false })
 * - httpx.Timeout(connect=5, read=10, write=10, pool=10) -> axios 单一整体超时 10s
 * - httpx cookie jar -> 手动保存 login 响应的 set-cookie: SID，后续请求带 Cookie 头
 * - httpx data=dict -> URLSearchParams 表单 POST；files= -> 全局 FormData + Blob
 * - httpx 默认不跟随重定向 -> maxRedirects: 0
 */
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';

import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';

import {
  AddResult,
  AsyncLock,
  ConnectionError,
  type DownloaderCapabilities,
  type DownloaderClient,
  RenameOutcome,
  RenameResult,
  sleep,
} from '../base';

const logger = new Logger('QbDownloader');

const MAGNET_BTIH_RE = /xt=urn:btih:([0-9A-Fa-f]{40}|[A-Za-z2-7]{32})/;

/** qb_connect_failed_wait 装饰器的重试间隔（秒）。 */
const CONNECT_RETRY_DELAYS = [0.5, 1, 1.5, 2, 3];

/** httpx.Response 的最小等价物（只覆盖本模块用到的字段）。 */
interface QbResponse {
  status: number;
  text: string;
  json(): unknown;
  setCookie: string[];
}

interface QbUploadFile {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface QbRequestOptions {
  params?: Record<string, string>;
  data?: Record<string, string>;
  files?: Record<string, QbUploadFile> | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** httpx.ConnectError 的 axios 等价判断：请求发出但无响应（非超时中止）。 */
function isConnectError(e: unknown): boolean {
  return axios.isAxiosError(e) && e.response === undefined && e.code !== 'ECONNABORTED';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** RFC4648 base32 -> hex（磁力 btih 32 字符形式转 40 字符 hex）。 */
function base32ToHex(input: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const ch of input.toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out += ((value >>> (bits - 8)) & 0xff).toString(16).padStart(2, '0');
      bits -= 8;
    }
  }
  return out;
}

/**
 * 从 .torrent 字节中提取 v1 infohash（bencoded ``info`` 字典的 SHA-1）。
 *
 * qB ≤5.1 对重复上传只回笼统的 "Fails."——要确认"其实已存在"就得拿文件
 * 自己算 hash 去查。手写极简 bencode 游标（只需定位 info 值的字节区间，
 * 不需要完整解码），损坏/非 bencode 输入返回 null。
 */
export function torrentInfohash(data: Buffer): string | null {
  const B_INT = 0x69; // 'i'
  const B_END = 0x65; // 'e'
  const B_LIST = 0x6c; // 'l'
  const B_DICT = 0x64; // 'd'
  const B_COLON = 0x3a; // ':'

  /** 返回从 i 开始的 bencode 元素的结束下标（exclusive）。 */
  const skip = (i: number): number => {
    if (i >= data.length) throw new Error('bad bencode');
    const c = data[i];
    if (c === B_INT) {
      const e = data.indexOf(B_END, i);
      if (e === -1) throw new Error('bad bencode');
      return e + 1;
    }
    if (c === B_LIST || c === B_DICT) {
      i += 1;
      while (true) {
        if (i >= data.length) throw new Error('bad bencode');
        if (data[i] === B_END) break;
        i = skip(i);
      }
      return i + 1;
    }
    const colon = data.indexOf(B_COLON, i);
    if (colon === -1) throw new Error('bad bencode');
    const lenText = data.subarray(i, colon).toString('latin1');
    // Python int() 严格（'3.5' → ValueError → 整体 None）
    if (!/^\d+$/.test(lenText)) throw new Error('bad bencode');
    const len = parseInt(lenText, 10);
    return colon + 1 + len;
  };

  try {
    if (data[0] !== B_DICT) return null;
    let i = 1;
    while (i < data.length && data[i] !== B_END) {
      const colon = data.indexOf(B_COLON, i);
      if (colon === -1) return null;
      const keyLen = parseInt(data.subarray(i, colon).toString('latin1'), 10);
      if (Number.isNaN(keyLen) || keyLen < 0) return null;
      const key = data.subarray(colon + 1, colon + 1 + keyLen);
      i = colon + 1 + keyLen;
      const end = skip(i);
      if (key.toString('latin1') === 'info') {
        if (data[i] !== B_DICT) return null;
        return createHash('sha1').update(data.subarray(i, end)).digest('hex');
      }
      i = end;
    }
    return null;
  } catch {
    return null;
  }
}

export class QbDownloader implements DownloaderClient {
  readonly capabilities: DownloaderCapabilities = {
    can_query: true,
    can_rename: true,
    can_manage: true,
    can_rss_rules: true,
  };

  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  private readonly ssl: boolean;
  private client: AxiosInstance | null = null;
  private authed = false;
  // 最近一次 auth 失败的原因（unreachable | credentials | banned），
  // 供上层（checker/startup 等待循环）区分故障类型；成功后清空。
  lastAuthError: string | null = null;
  // 手动维护的会话 cookie（对应 httpx 的 cookie jar，只存 SID）。
  private sid: string | null = null;
  // Single-flights the reactive 403 re-login below so concurrent
  // requests don't each fire their own login attempt and trip
  // qBittorrent's IP ban (#1046-adjacent).
  private readonly authLock = new AsyncLock();
  // 每完成一次真实登录尝试 +1：让排在锁后的并发等待者识别"我等待期间
  // 已有一次登录被凭据拒绝"，从而不再补发自己的 POST。
  private authGeneration = 0;
  // qB 5.0 把 torrents/pause|resume 改名为 stop|start 且无别名（旧名
  // 404），4.x 则没有新名。记住哪套命名有效；null = 还没探测过。
  private usesStopStart: boolean | null = null;

  constructor(host: string, username: string, password: string, ssl: boolean) {
    if (!host.includes('://')) {
      const scheme = ssl ? 'https' : 'http';
      this.host = `${scheme}://${host}`;
    } else {
      this.host = host;
    }
    this.username = username;
    this.password = password;
    this.ssl = ssl;
  }

  private url(endpoint: string): string {
    return `${this.host}/api/v2/${endpoint}`;
  }

  private newClient(): AxiosInstance {
    // Python: httpx.Limits(max_keepalive_connections=5, max_connections=10,
    // keepalive_expiry=30.0) —— 空闲 socket 短寿化，防止复用被代理/NAS 静默
    // 回收的半开连接（#984：rename 周期首个请求 Server disconnected）。
    // Node http.Agent 无 idle TTL：maxSockets=10 / maxFreeSockets=5 对齐上限，
    // 另起 30s 周期清理 freeSockets 作为 keepalive_expiry 的等价物。
    const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5 });
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 5,
    });
    this.pruneFreeSockets(httpAgent);
    this.pruneFreeSockets(httpsAgent);
    return axios.create({
      timeout: 10_000,
      maxRedirects: 0,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      transformResponse: (d) => d,
      // Never verify certificates - self-signed certs are the norm for
      // home-server / NAS / Docker qBittorrent setups.
      httpsAgent,
      httpAgent,
    });
  }

  /** keepalive_expiry=30s 的 Node 等价：周期销毁空闲 socket（在途请求不受影响）。 */
  private pruneFreeSockets(agent: http.Agent | https.Agent): void {
    const timer = setInterval(() => {
      const freeSockets = (agent as unknown as { freeSockets?: Record<string, unknown[]> })
        .freeSockets;
      if (!freeSockets) return;
      for (const key of Object.keys(freeSockets)) {
        for (const sock of freeSockets[key] as Array<{ destroy(): void }>) {
          sock.destroy();
        }
      }
    }, 30_000);
    timer.unref();
  }

  async auth(retry = 3): Promise<boolean> {
    // Session reuse: a live, already-authenticated client short-circuits so
    // repeated operations don't re-login every cycle (#1039 / #900).
    if (this.client !== null && this.authed) {
      return true;
    }
    // 单飞：并发的 loop tick 同时 auth() 时只发一次 login POST——失败的
    // 并发登录会各自计入 qB 的 WebUI IP ban 阈值（默认 5 次即封禁）。
    const generation = this.authGeneration;
    return this.authLock.run(async () => {
      if (this.client !== null && this.authed) {
        return true;
      }
      if (generation !== this.authGeneration && this.lastAuthError === 'credentials') {
        // 等锁期间已有一次真实登录被凭据拒绝：共享这个否定结果，
        // 不再补发自己的 POST。之后的全新 auth() 调用（如 checker
        // 主动探测）不受影响，仍可重试并在成功后清除失败原因。
        return false;
      }
      return this.lockedAuth(retry);
    });
  }

  /** auth() 的主体；调用方必须已持有 ``authLock``。 */
  private async lockedAuth(retry = 3): Promise<boolean> {
    if (this.client !== null && this.authed) {
      return true;
    }
    try {
      return await this.loginAttempt(retry);
    } finally {
      // 尝试结束后才 +1：在本次尝试期间排队的等待者捕获的是旧值，
      // 醒来后据此识别"结果已出"，共享失败结论而非重复 POST。
      this.authGeneration += 1;
    }
  }

  private async loginAttempt(retry = 3): Promise<boolean> {
    let times = 0;
    const useHttps = this.host.startsWith('https://');
    if (this.client === null) {
      this.client = this.newClient();
    }
    while (times < retry) {
      let resp: QbResponse;
      try {
        resp = await this.rawRequest('POST', 'auth/login', {
          data: { username: this.username, password: this.password },
        });
      } catch (e) {
        if (isConnectError(e)) {
          this.lastAuthError = 'unreachable';
          if (useHttps) {
            logger.error(
              'Cannot connect to qBittorrent Server via HTTPS. ' +
                'If your qBittorrent uses plain HTTP, disable SSL in download settings.',
            );
          } else {
            logger.error('Cannot connect to qBittorrent Server');
          }
          logger.log('Please check the IP and port in WebUI settings');
          logger.debug(`Connection error detail: ${errMsg(e)}`);
          await sleep(10);
          times += 1;
          continue;
        }
        this.lastAuthError = 'unreachable';
        if (useHttps && String(e).toLowerCase().includes('ssl')) {
          logger.error(
            'TLS/SSL error connecting to qBittorrent. ' +
              'If your qBittorrent uses plain HTTP, disable SSL in download settings.',
          );
        } else {
          logger.error(`Unknown error: ${errMsg(e)}`);
        }
        break;
      }
      // qBittorrent < 5.2 answers 200 + "Ok." / "Fails.";
      // qBittorrent >= 5.2 answers 204 with an empty body on success
      // (#1044). Keep the positive body check for 200 so a proxy or
      // non-qB service answering 200 + HTML is not mistaken for a
      // successful login.
      if ((resp.status === 200 && resp.text.startsWith('Ok')) || resp.status === 204) {
        this.captureSid(resp);
        this.authed = true;
        this.lastAuthError = null;
        return true;
      }
      if ((resp.status === 200 && resp.text.startsWith('Fails')) || resp.status === 401) {
        // 密码错误重试只会触发 qB 的 WebUI IP ban（默认 5 次失败
        // 即封禁，之后全部 403），必须立刻停下并明确提示。
        this.lastAuthError = 'credentials';
        logger.error(
          'qBittorrent rejected the username or password. ' +
            'Check the downloader credentials in AutoBangumi settings; ' +
            'not retrying to avoid a WebUI IP ban.',
        );
        break;
      }
      if (resp.status === 403) {
        this.lastAuthError = 'banned';
        logger.error('Login refused by qBittorrent Server');
        logger.log('Please release the IP in qBittorrent Server');
        break;
      }
      this.lastAuthError = 'unreachable';
      logger.error(
        `Can't login qBittorrent Server ${this.host} by ${this.username}, retry in 5 seconds.`,
      );
      await sleep(5);
      times += 1;
    }
    return false;
  }

  /** 从 login 响应的 set-cookie 里取出 SID（对应 httpx cookie jar）。 */
  private captureSid(resp: QbResponse): void {
    for (const entry of resp.setCookie) {
      const m = /(?:^|;\s*)SID=([^;]*)/.exec(entry);
      if (m) {
        this.sid = m[1];
        return;
      }
    }
  }

  private wrapResponse(resp: AxiosResponse): QbResponse {
    const content = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data ?? '');
    const rawSetCookie = resp.headers['set-cookie'] as string[] | string | undefined;
    const setCookie =
      rawSetCookie === undefined
        ? []
        : Array.isArray(rawSetCookie)
          ? rawSetCookie
          : [rawSetCookie];
    return {
      status: resp.status,
      text: content.toString('utf-8'),
      json: () => JSON.parse(content.toString('utf-8')) as unknown,
      setCookie,
    };
  }

  /** 直接发请求（不做 403 重登）；login/logout 专用。 */
  private async rawRequest(
    method: 'GET' | 'POST',
    endpoint: string,
    opts: QbRequestOptions = {},
  ): Promise<QbResponse> {
    if (this.client === null) {
      throw new Error('QbDownloader.auth() must run first');
    }
    const headers: Record<string, string> = {};
    if (this.sid) {
      headers['Cookie'] = `SID=${this.sid}`;
    }
    let resp: AxiosResponse;
    const url = this.url(endpoint);
    if (method === 'GET') {
      resp = await this.client.get(url, { params: opts.params, headers });
    } else if (opts.files && Object.keys(opts.files).length > 0) {
      const form = new FormData();
      for (const [k, v] of Object.entries(opts.data ?? {})) form.append(k, v);
      for (const [k, f] of Object.entries(opts.files)) {
        form.append(k, new Blob([f.content], { type: f.contentType }), f.filename);
      }
      resp = await this.client.post(url, form, { headers });
    } else {
      resp = await this.client.post(url, new URLSearchParams(opts.data ?? {}).toString(), {
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    }
    return this.wrapResponse(resp);
  }

  /**
   * Issue a request, re-authenticating once if the session expired.
   *
   * qBittorrent answers 403 when the session cookie is no longer valid
   * (e.g. the server restarted or reaped the session). Since we now keep one
   * long-lived session, force a single re-login and retry the request once.
   * The re-login is single-flighted behind ``authLock`` so a burst of
   * concurrent requests hitting 403 at once triggers one login attempt,
   * not one per request (a login storm can get the caller's IP banned by
   * qBittorrent). Only retry the original request if re-auth succeeded.
   */
  private async request(
    method: 'GET' | 'POST',
    endpoint: string,
    opts: QbRequestOptions = {},
  ): Promise<QbResponse> {
    if (this.client === null) {
      throw new Error('QbDownloader.auth() must run first');
    }
    let resp = await this.rawRequest(method, endpoint, opts);
    if (resp.status === 403) {
      this.authed = false;
      await this.authLock.run(async () => {
        // Another waiter may have already refreshed the session while
        // we were blocked on the lock.
        if (!this.authed) {
          await this.lockedAuth();
        }
      });
      if (!this.authed) {
        throw new ConnectionError(
          `Re-authentication to qBittorrent at ${this.host} ` +
            'failed; not retrying request to avoid a login storm.',
        );
      }
      resp = await this.rawRequest(method, endpoint, opts);
    }
    return resp;
  }

  private get(endpoint: string, opts: QbRequestOptions = {}): Promise<QbResponse> {
    return this.request('GET', endpoint, opts);
  }

  private post(endpoint: string, opts: QbRequestOptions = {}): Promise<QbResponse> {
    return this.request('POST', endpoint, opts);
  }

  /**
   * qb_connect_failed_wait 装饰器的等价物：连接类错误重试 5 次
   * （0.5/1/1.5/2/3s），耗尽后抛出最后一个错误而不是静默返回 null。
   */
  private async withConnectRetry<T>(fn: () => Promise<T>): Promise<T> {
    let times = 0;
    let lastError: unknown = null;
    while (times < 5) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ConnectionError) && !axios.isAxiosError(e)) {
          throw e;
        }
        lastError = e;
        const delay = CONNECT_RETRY_DELAYS[times];
        logger.debug(`URL: ${this.host}`);
        logger.warn(errMsg(e));
        logger.warn(`Cannot connect to qBittorrent. Wait ${delay.toFixed(1)}s and retry...`);
        await sleep(delay);
        times += 1;
      }
    }
    // Retries exhausted: re-raise instead of silently returning None,
    // which crashed callers with a much more confusing error further down.
    logger.error(`Cannot connect to qBittorrent after ${times} retries.`);
    throw lastError;
  }

  async logout(): Promise<void> {
    if (this.client) {
      try {
        await this.rawRequest('POST', 'auth/logout');
      } catch (e) {
        logger.debug(`Logout request failed (non-critical): ${errMsg(e)}`);
      }
      // axios 没有 aclose()；销毁自建 agent 释放连接池
      const client = this.client;
      this.client = null;
      (client.defaults.httpsAgent as https.Agent | undefined)?.destroy();
      (client.defaults.httpAgent as http.Agent | undefined)?.destroy();
    }
    this.sid = null;
    this.authed = false;
  }

  async checkHost(): Promise<boolean> {
    try {
      const resp = await this.get('app/version');
      return resp.status === 200;
    } catch (e) {
      if (axios.isAxiosError(e)) return false;
      throw e;
    }
  }

  checkRss(_rssLink: string): void {
    // pass（与 Python 一致的空实现）
  }

  async prefsInit(prefs: Record<string, unknown>): Promise<QbResponse> {
    return this.withConnectRetry(() =>
      this.post('app/setPreferences', { data: { json: JSON.stringify(prefs) } }),
    );
  }

  async getAppPrefs(): Promise<Record<string, unknown>> {
    const resp = await this.withConnectRetry(() => this.get('app/preferences'));
    return resp.json() as Record<string, unknown>;
  }

  async addCategory(category: string): Promise<void> {
    await this.post('torrents/createCategory', {
      data: { category, savePath: '' },
    });
  }

  async torrentsInfo(
    statusFilter: string | null,
    category: string | null,
    tag: string | null = null,
  ): Promise<Array<Record<string, unknown>>> {
    return this.withConnectRetry(async () => {
      const params: Record<string, string> = {};
      // qB 5.0 把 filter=paused 改名为 stopped，且未知 filter 值会静默
      // 退化成 All（返回全部种子）——服务端过滤无法跨版本，改为不带
      // filter 拉取后按 state 本地过滤。其余值（completed 等）未改名。
      const pausedFilter = statusFilter === 'paused' || statusFilter === 'stopped';
      if (statusFilter && !pausedFilter) {
        params['filter'] = statusFilter;
      }
      if (category) {
        params['category'] = category;
      }
      if (tag) {
        params['tag'] = tag;
      }
      const resp = await this.get('torrents/info', { params });
      let torrents = resp.json() as Array<Record<string, unknown>>;
      if (pausedFilter) {
        torrents = torrents.filter((t) => {
          const state = String(t['state'] ?? '');
          return state.startsWith('paused') || state.startsWith('stopped');
        });
      }
      return torrents;
    });
  }

  /** Query one hash without confusing a failed request with absence. */
  async torrentExists(torrentHash: string): Promise<boolean | null> {
    let payload: unknown;
    try {
      const resp = await this.get('torrents/info', { params: { hashes: torrentHash } });
      if (resp.status >= 300) {
        logger.warn(`Could not verify qBittorrent task ${torrentHash}: HTTP ${resp.status}`);
        return null;
      }
      payload = resp.json();
    } catch (e) {
      logger.warn(`Could not verify qBittorrent task ${torrentHash}: ${errMsg(e)}`);
      return null;
    }
    return (
      Array.isArray(payload) &&
      payload.some(
        (item) =>
          isRecord(item) &&
          String(item['hash'] ?? '').toLowerCase() === torrentHash.toLowerCase(),
      )
    );
  }

  async torrentsFiles(torrentHash: string): Promise<Array<Record<string, unknown>>> {
    return this.withConnectRetry(async () => {
      const resp = await this.get('torrents/files', { params: { hash: torrentHash } });
      return resp.json() as Array<Record<string, unknown>>;
    });
  }

  /**
   * 尽力确认"Fails."是否因为任务已存在：从磁力链提取 btih 并查询 qB。
   *
   * 只有全部 URL 都是可提取 hash 的磁力链、且每个 hash 都已在 qB 中时才
   * 返回 true；.torrent URL 无法事先得知 hash，返回 false（按失败处理）。
   */
  private async urlsAlreadyAdded(torrentUrls: string | string[] | null): Promise<boolean> {
    const urls = Array.isArray(torrentUrls) ? torrentUrls : torrentUrls ? [torrentUrls] : [];
    if (!urls.length) {
      return false;
    }
    const hashes: string[] = [];
    for (const url of urls) {
      const m = MAGNET_BTIH_RE.exec(url || '');
      if (!m) {
        return false;
      }
      let btih = m[1];
      if (btih.length === 32) {
        // base32 -> hex
        const hex = base32ToHex(btih);
        if (hex === null) {
          return false;
        }
        btih = hex;
      }
      hashes.push(btih.toLowerCase());
    }
    return this.hashesAllPresent(hashes);
  }

  /**
   * 尽力确认"Fails."是否因为任务已存在：对 .torrent 文件字节计算
   * infohash 并查询 qB。只有全部文件都能算出 hash、且每个 hash 都已在
   * qB 中时才返回 true；算不出 hash（损坏文件）返回 false（按失败处理）。
   */
  private async filesAlreadyAdded(torrentFiles: Buffer | Buffer[] | null): Promise<boolean> {
    if (!torrentFiles) {
      return false;
    }
    const fileList = Array.isArray(torrentFiles) ? torrentFiles : [torrentFiles];
    const hashes: string[] = [];
    for (const f of fileList) {
      const infohash = torrentInfohash(f);
      if (infohash === null) {
        return false;
      }
      hashes.push(infohash);
    }
    return this.hashesAllPresent(hashes);
  }

  private async hashesAllPresent(hashes: string[]): Promise<boolean> {
    if (!hashes.length) {
      return false;
    }
    try {
      const resp = await this.get('torrents/info', { params: { hashes: hashes.join('|') } });
      const payload = resp.json() as Array<Record<string, unknown>>;
      const found = new Set(payload.map((t) => String(t['hash'] ?? '').toLowerCase()));
      return hashes.every((h) => found.has(h));
    } catch {
      return false;
    }
  }

  /**
   * qB >= 5.2 的 torrents/add 回 JSON 计数；旧版本回 "Ok."/"Fails."。
   * 不是该结构（如代理返回的 HTML 错误页）时返回 null，走通用失败路径。
   */
  private static parseAddResponseJson(resp: QbResponse): Record<string, unknown> | null {
    let data: unknown;
    try {
      data = resp.json();
    } catch {
      return null;
    }
    if (isRecord(data) && 'success_count' in data) {
      return data;
    }
    return null;
  }

  async addTorrents(
    torrentUrls: string | string[] | null,
    torrentFiles: Buffer | Buffer[] | null,
    savePath: string,
    category: string,
    tags: string | null = null,
  ): Promise<AddResult> {
    const data: Record<string, string> = {
      savepath: savePath,
      category,
      // qB 5.0 把 paused 参数改名为 stopped；双方都静默忽略未知参数，
      // 两个都发才能覆盖所有版本。
      paused: 'false',
      stopped: 'false',
      autoTMM: 'false',
      contentLayout: 'NoSubfolder',
    };
    if (tags) {
      data['tags'] = tags;
    }
    const files: Record<string, QbUploadFile> = {};
    if (torrentUrls) {
      if (Array.isArray(torrentUrls)) {
        data['urls'] = torrentUrls.join('\n');
      } else {
        data['urls'] = torrentUrls;
      }
    }
    if (torrentFiles) {
      if (Array.isArray(torrentFiles)) {
        torrentFiles.forEach((f, i) => {
          files[`torrents_${i}`] = {
            filename: `torrent_${i}.torrent`,
            content: f,
            contentType: 'application/x-bittorrent',
          };
        });
      } else {
        files['torrents'] = {
          filename: 'torrent.torrent',
          content: torrentFiles,
          contentType: 'application/x-bittorrent',
        };
      }
    }

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await this.post('torrents/add', {
          data,
          files: Object.keys(files).length > 0 ? files : null,
        });
        if (resp.status === 200 && resp.text === 'Ok.') {
          return AddResult.ADDED;
        }
        if (resp.status === 200 || resp.status === 202) {
          // qBittorrent >= 5.2 返回逐种子 JSON 结果：
          // {"added_torrent_ids": [...], "failure_count": 0,
          //  "pending_count": 0, "success_count": 1}
          // URL 形式的 add 是异步下载，qB 回 202 + pending_count>0
          // ——已受理即算成功。部分成功也按 ADDED 处理：与旧版
          // "Ok."（>=1 成功即 Ok.）和 aria2 客户端的约定一致，
          // 否则已投递的种子会被整批记成失败。计数全 0 说明什么
          // 都没发生，不算成功。
          const counts = QbDownloader.parseAddResponseJson(resp);
          if (counts !== null && (counts['success_count'] || counts['pending_count'])) {
            return AddResult.ADDED;
          }
          // "Fails."（qB <= 5.1）与 JSON failure_count > 0 都覆盖
          // 所有被拒绝的 add（重复、种子损坏、磁力链无法解析……），
          // 不能一律当重复——否则损坏种子会被记成已下载、永远不
          // 重试。只有能通过 hash（磁力链的 btih 或 .torrent 文件
          // 算出的 infohash）确认任务已存在时才归类为重复，
          // 其余按失败抛出让上层重试。
          if (
            (await this.urlsAlreadyAdded(torrentUrls)) ||
            (await this.filesAlreadyAdded(torrentFiles))
          ) {
            return AddResult.DUPLICATE;
          }
          throw new ConnectionError(
            `qBittorrent rejected torrent add (${resp.status} ${JSON.stringify(resp.text)}) ` +
              'and no matching torrent found',
          );
        }
        if (resp.status === 409) {
          // qBittorrent >= 5.2：全部为重复/失败且无 pending 时回
          // 409 Conflict (qbittorrent/qBittorrent#18361)。文件上传
          // 是同步解析的，损坏文件走 415（BadData），所以文件的
          // 409 就是重复；磁力链尽力用 hash 确认，确认不了的按
          // 失败抛出，避免把损坏的 add 记成已下载、永远不重试。
          if (torrentFiles !== null || (await this.urlsAlreadyAdded(torrentUrls))) {
            return AddResult.DUPLICATE;
          }
          throw new ConnectionError(
            'qBittorrent rejected torrent add (409 Conflict) and no matching torrent found',
          );
        }
        throw new ConnectionError(
          `qBittorrent rejected torrent add: HTTP ${resp.status} ${JSON.stringify(resp.text)}`,
        );
      } catch (e) {
        // 只重试网络错误（httpx.ReadError/ConnectError/RequestError 等价物）；
        // 上面主动抛出的 ConnectionError 不重试，直接传播给上层。
        if (!axios.isAxiosError(e)) {
          throw e;
        }
        if (attempt < maxRetries - 1) {
          logger.warn(
            `Network error adding torrent (attempt ${attempt + 1}/${maxRetries}): ${errMsg(e)}`,
          );
          await sleep(2);
        } else {
          logger.error(`Failed to add torrent after ${maxRetries} attempts: ${errMsg(e)}`);
          throw e;
        }
      }
    }
    /* istanbul ignore next -- 循环必然以 return/throw 结束 */
    throw new Error('unreachable');
  }

  async getTorrentsByTag(tag: string): Promise<Array<Record<string, unknown>>> {
    const resp = await this.get('torrents/info', { params: { tag } });
    return resp.json() as Array<Record<string, unknown>>;
  }

  /**
   * qBittorrent expects one pipe-joined "hashes" field; a Python list
   * would be form-encoded as repeated fields and silently ignored (#1046).
   * Centralized here so every hashes-taking endpoint applies it the same
   * way.
   */
  private static normalizeHashes(hashes: string | string[]): string {
    return Array.isArray(hashes) ? hashes.join('|') : hashes;
  }

  async torrentsDelete(hash: string | string[], deleteFiles = true): Promise<boolean> {
    const hashes = QbDownloader.normalizeHashes(hash);
    const resp = await this.post('torrents/delete', {
      data: { hashes, deleteFiles: String(deleteFiles).toLowerCase() },
    });
    // qB 5.2 起空响应体统一回 204，不能用 ==200 判定
    if (resp.status >= 300) {
      logger.error(`Failed to delete torrents ${hashes}: HTTP ${resp.status}`);
      return false;
    }
    return true;
  }

  /**
   * qB 5.0 把 pause/resume 改名为 stop/start 且无别名（旧名 404），
   * 4.x 没有新名。先试上次成功的那套命名（默认新名），404 时换另一套
   * 并记住。操作幂等，重发一次无副作用。
   */
  private async startStop(
    hashes: string | string[],
    modern: string,
    legacy: string,
  ): Promise<void> {
    const data = { hashes: QbDownloader.normalizeHashes(hashes) };
    const preferModern = this.usesStopStart !== false;
    const [first, second] = preferModern ? [modern, legacy] : [legacy, modern];
    let used = first;
    let resp = await this.post(`torrents/${first}`, { data });
    if (resp.status === 404) {
      used = second;
      resp = await this.post(`torrents/${second}`, { data });
      if (resp.status !== 404) {
        this.usesStopStart = second === modern;
      }
    } else {
      this.usesStopStart = first === modern;
    }
    if (resp.status >= 300) {
      logger.error(`Failed to ${used} torrents ${data.hashes}: HTTP ${resp.status}`);
    }
  }

  async torrentsPause(hashes: string | string[]): Promise<void> {
    await this.startStop(hashes, 'stop', 'pause');
  }

  async torrentsResume(hashes: string | string[]): Promise<void> {
    await this.startStop(hashes, 'start', 'resume');
  }

  async torrentsRenameFile(
    torrentHash: string,
    oldPath: string,
    newPath: string,
    verify = true,
  ): Promise<RenameResult> {
    try {
      const resp = await this.post('torrents/renameFile', {
        data: { hash: torrentHash, oldPath, newPath },
      });
      if (resp.status === 409) {
        logger.debug(`Conflict409Error: ${oldPath} >> ${newPath}`);
        return new RenameResult(
          RenameOutcome.DESTINATION_EXISTS,
          'qBittorrent rejected rename with HTTP 409',
        );
      }
      // qB 5.2 对成功的 renameFile 回 204（空响应体全局改为 204）
      if (resp.status >= 300) {
        return new RenameResult(
          RenameOutcome.RETRYABLE_FAILURE,
          `qBittorrent rename returned HTTP ${resp.status}`,
        );
      }

      if (!verify) {
        return new RenameResult(RenameOutcome.RENAMED);
      }

      // Verify the rename actually happened by checking file list
      // qBittorrent can return 200 but delay the actual rename (e.g., while seeding)
      // Use exponential backoff: 0.1s, 0.2s, 0.4s (max 3 attempts)
      for (let attempt = 0; attempt < 3; attempt++) {
        const delay = 0.1 * 2 ** attempt;
        await sleep(delay);
        const files = await this.torrentsFiles(torrentHash);
        if (files.some((f) => f['name'] === newPath)) {
          return new RenameResult(RenameOutcome.RENAMED);
        }
        // new_path 未出现（旧名仍在，或两个名字都不在列表里）一律不算
        // 成功：盲目返回 True 会让 renamer 每周期重复改名 + 发通知
        // (#754/#749)。返回 False 由调用方走 _PENDING_RENAME_COOLDOWN 退避。
        if (attempt === 2) {
          logger.debug(
            `Rename API returned 200 but ${newPath} never appeared ` + `(rename of ${oldPath})`,
          );
        }
      }
      return new RenameResult(
        RenameOutcome.RETRYABLE_FAILURE,
        'qBittorrent did not expose the target path after rename',
      );
    } catch (e) {
      // httpx.ConnectError / RequestError / TimeoutException 等价物
      if (axios.isAxiosError(e)) {
        logger.warn(`Failed to rename file ${oldPath}: ${errMsg(e)}`);
        return new RenameResult(RenameOutcome.RETRYABLE_FAILURE, errMsg(e));
      }
      throw e;
    }
  }

  async rssAddFeed(url: string, itemPath: string): Promise<void> {
    const resp = await this.post('rss/addFeed', {
      data: { url, path: itemPath },
    });
    if (resp.status === 409) {
      logger.warn(`RSS feed ${url} already exists`);
    }
  }

  async rssRemoveItem(itemPath: string): Promise<void> {
    const resp = await this.post('rss/removeItem', {
      data: { path: itemPath },
    });
    if (resp.status === 409) {
      logger.warn(`RSS item ${itemPath} does not exist`);
    }
  }

  async rssGetFeeds(): Promise<Record<string, unknown>> {
    const resp = await this.get('rss/items');
    return resp.json() as Record<string, unknown>;
  }

  async rssSetRule(ruleName: string, ruleDef: Record<string, unknown>): Promise<void> {
    await this.post('rss/setRule', {
      data: { ruleName, ruleDef: JSON.stringify(ruleDef) },
    });
  }

  async moveTorrent(hashes: string | string[], newLocation: string): Promise<void> {
    await this.post('torrents/setLocation', {
      data: { hashes: QbDownloader.normalizeHashes(hashes), location: newLocation },
    });
  }

  async getDownloadRule(): Promise<Record<string, unknown>> {
    const resp = await this.get('rss/rules');
    return resp.json() as Record<string, unknown>;
  }

  async getTorrentPath(hash: string): Promise<string> {
    const resp = await this.get('torrents/info', { params: { hashes: hash } });
    const torrents = resp.json() as Array<Record<string, unknown>>;
    if (torrents.length) {
      return String(torrents[0]['save_path'] ?? '');
    }
    return '';
  }

  async setCategory(hash: string | string[], category: string): Promise<void> {
    const hashes = QbDownloader.normalizeHashes(hash);
    const resp = await this.post('torrents/setCategory', {
      data: { hashes, category },
    });
    if (resp.status === 409) {
      logger.warn(`Category ${category} does not exist`);
      await this.addCategory(category);
      await this.post('torrents/setCategory', {
        data: { hashes, category },
      });
    }
  }

  async checkConnection(): Promise<string> {
    const resp = await this.get('app/version');
    return resp.text;
  }

  async removeRule(ruleName: string): Promise<void> {
    await this.post('rss/removeRule', {
      data: { ruleName },
    });
  }

  async addTag(hash: string, tag: string): Promise<void> {
    await this.post('torrents/addTags', {
      data: { hashes: hash, tags: tag },
    });
  }
}
