/**
 * Shared HTTP layer — 1:1 port of module/network/request_url.py (httpx -> axios).
 *
 * Mapping notes:
 * - httpx.Timeout(connect=10, read=30, write=10, pool=10) -> axios `timeout: 30s`
 *   (axios exposes a single whole-request timeout).
 * - follow_redirects=True -> axios default (maxRedirects>0).
 * - httpcore PoolTimeout tunnel leak (#1104) is httpx-specific; axios agents do
 *   not leak that way, so the stale-client replacement hook is kept for parity
 *   but effectively only fires on settings reload.
 */
import { Logger } from '@nestjs/common';
import axios, {
  type AxiosInstance,
  type AxiosProxyConfig,
  type AxiosResponse,
} from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import iconv from 'iconv-lite';

import { settings } from '../config/settings';
import { expandEnv } from '../utils/env';

const logger = new Logger('RequestURL');

// HTTP 429 限流退避（#1052）
const HTTP_429_FALLBACK_DELAY = 10.0;
const HTTP_429_MAX_RETRY_AFTER = 60.0;

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** 从 429 响应解析等待秒数；仅接受数字形式的 Retry-After。 */
function retryAfterDelay(headers: Record<string, unknown>): number {
  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined && retryAfter !== null) {
    const value = Number(String(retryAfter));
    if (Number.isNaN(value)) return HTTP_429_FALLBACK_DELAY;
    return Math.min(Math.max(value, 0), HTTP_429_MAX_RETRY_AFTER);
  }
  return HTTP_429_FALLBACK_DELAY;
}

function proxyConfigKey(): string {
  const proxy = settings.data.proxy;
  if (proxy.enable) {
    return `${proxy.type}:${proxy.host}:${proxy.port}:${proxy.username}`;
  }
  return '';
}

function buildClient(): AxiosInstance {
  const proxy = settings.data.proxy;
  const instance = axios.create({
    timeout: 30_000,
    maxRedirects: 5,
    // Manual status handling (httpx raise_for_status parity)
    validateStatus: () => true,
    responseType: 'arraybuffer',
    transformResponse: (d) => d,
    decompress: true,
  });
  // Python 端 Proxy.username/password 是 expandvars property——使用处同样展开
  const proxyUser = expandEnv(proxy.username);
  const proxyPass = expandEnv(proxy.password);
  if (proxy.enable) {
    if (proxy.type.includes('http')) {
      const proxyConfig: AxiosProxyConfig = {
        protocol: 'http',
        host: proxy.host,
        port: proxy.port,
      };
      if (proxyUser) {
        proxyConfig.auth = { username: proxyUser, password: proxyPass };
      }
      instance.defaults.proxy = proxyConfig;
    } else if (proxy.type === 'socks5') {
      const auth = proxyUser ? `${proxyUser}:${proxyPass}@` : '';
      const agent = new SocksProxyAgent(`socks5://${auth}${proxy.host}:${proxy.port}`);
      instance.defaults.httpAgent = agent;
      instance.defaults.httpsAgent = agent;
      instance.defaults.proxy = false;
    }
  }
  return instance;
}

let sharedClient: AxiosInstance | null = null;
let sharedClientProxyKey: string | null = null;

export function getSharedClient(): AxiosInstance {
  const currentKey = proxyConfigKey();
  if (sharedClient !== null && sharedClientProxyKey === currentKey) {
    return sharedClient;
  }
  sharedClient = buildClient();
  sharedClientProxyKey = currentKey;
  return sharedClient;
}

/** 关闭并清除共享客户端，下次请求时自动创建新连接池。 */
export function resetSharedClient(): void {
  sharedClient = null;
  sharedClientProxyKey = null;
}

export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

/** Minimal httpx.Response equivalent. */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  content: Buffer;
  text: string;
  json<T = unknown>(): T;
}

function toRawResponse(resp: AxiosResponse): RawResponse {
  const content = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data ?? '');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(resp.headers)) {
    headers[k.toLowerCase()] = String(v);
  }
  return {
    status: resp.status,
    headers,
    content,
    get text() {
      // httpx .text 语义：按 Content-Type charset 解码（GBK/GB2312 的国内
      // tracker/RSS 会正确解码，而非固定 UTF-8 变乱码）
      const ct = headers['content-type'] ?? '';
      const m = /charset=([\w-]+)/i.exec(ct);
      const charset = m ? m[1].toLowerCase() : 'utf-8';
      try {
        if (charset !== 'utf-8' && charset !== 'utf8' && iconv.encodingExists(charset)) {
          return iconv.decode(content, charset);
        }
      } catch {
        /* fall through to utf-8 */
      }
      return content.toString('utf-8');
    },
    json<T>(): T {
      return JSON.parse(this.text) as T;
    },
  };
}

export class RequestURL {
  // More complete User-Agent to avoid Cloudflare blocking
  static DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  protected header = {
    'User-Agent': RequestURL.DEFAULT_UA,
    Accept: 'application/xml',
  };

  /** Get appropriate headers based on URL type. */
  protected getHeaders(url: string): Record<string, string> {
    const baseHeaders: Record<string, string> = {
      'User-Agent': RequestURL.DEFAULT_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
      Connection: 'keep-alive',
    };
    if (url.endsWith('.torrent') || url.includes('/download/')) {
      baseHeaders.Accept = 'application/x-bittorrent, application/octet-stream, */*';
    } else {
      baseHeaders.Accept = 'application/xml, text/xml, */*';
    }
    return baseHeaders;
  }

  async getUrl(url: string, retry = 3): Promise<RawResponse | null> {
    let tryTime = 0;
    const headers = this.getHeaders(url);
    const client = getSharedClient();
    while (true) {
      let resp: AxiosResponse;
      try {
        resp = await client.get(url, { headers });
        logger.debug(`Successfully connected to ${url}. Status: ${resp.status}`);
      } catch (e) {
        logger.warn(
          `Request error for ${url}: ${(e as Error).name}. Retry ${tryTime + 1}/${retry}`,
        );
        tryTime += 1;
        if (tryTime >= retry) break;
        await sleep(5);
        continue;
      }
      if (resp.status < 400) {
        return toRawResponse(resp);
      }
      logger.warn(`HTTP ${resp.status} from ${url}`);
      if (resp.status !== 429) break;
      // 429 限流：按 Retry-After 退避后重试（#1052）
      tryTime += 1;
      if (tryTime >= retry) break;
      const delay = retryAfterDelay(resp.headers as Record<string, unknown>);
      logger.warn(`Rate limited by ${url}, retrying in ${delay.toFixed(0)}s (${tryTime}/${retry})`);
      await sleep(delay);
    }
    logger.error(`Unable to connect to ${url}, Please check your network settings`);
    return null;
  }

  /** Form-encoded POST (httpx data=dict). */
  async postUrl(url: string, data: Record<string, string>, retry = 3): Promise<RawResponse | null> {
    let tryTime = 0;
    const client = getSharedClient();
    while (true) {
      let resp: AxiosResponse;
      try {
        resp = await client.post(url, new URLSearchParams(data).toString(), {
          headers: {
            ...this.header,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });
      } catch (e) {
        logger.warn(`Cannot connect to ${url}. Wait for 5 seconds.`);
        tryTime += 1;
        if (tryTime >= retry) break;
        await sleep(5);
        continue;
      }
      if (resp.status < 400) {
        return toRawResponse(resp);
      }
      // 服务端拒绝不是连接失败，重试无意义；记录状态码和响应体（#1094）
      const body = Buffer.isBuffer(resp.data) ? resp.data.toString('utf-8') : '';
      logger.warn(`HTTP ${resp.status} from ${url}: ${body.slice(0, 200)}`);
      break;
    }
    logger.error(`Failed connecting to ${url}`);
    logger.warn('Please check DNS/Connection settings');
    return null;
  }

  async checkUrl(url: string): Promise<boolean> {
    let target = url;
    if (!target.includes('://')) {
      target = `http://${target}`;
    }
    try {
      const resp = await getSharedClient().head(target, { headers: this.header });
      return resp.status < 400;
    } catch {
      logger.debug(`Cannot connect to ${target}.`);
      return false;
    }
  }

  /** Multipart form POST (httpx data= + files=). */
  async postForm(
    url: string,
    data: Record<string, string>,
    files: Record<string, { filename: string; content: Buffer; contentType?: string }>,
  ): Promise<RawResponse | null> {
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(data)) form.append(k, v);
      for (const [k, f] of Object.entries(files)) {
        form.append(k, new Blob([f.content], { type: f.contentType ?? 'application/octet-stream' }), f.filename);
      }
      const resp = await getSharedClient().post(url, form, {
        // Python post_form 用 self.header（UA + Accept: application/xml）
        headers: { ...this.header },
      });
      if (resp.status >= 400) {
        const body = Buffer.isBuffer(resp.data) ? resp.data.toString('utf-8') : '';
        logger.warn(`HTTP ${resp.status} from ${url}: ${body.slice(0, 200)}`);
        return null;
      }
      return toRawResponse(resp);
    } catch {
      logger.warn(`Cannot connect to ${url}.`);
      return null;
    }
  }

  /** POST a JSON body (used by Discord/Webhook/Gotify/Bark providers). */
  async postJson(
    url: string,
    jsonData: unknown,
    headers?: Record<string, string>,
  ): Promise<RawResponse | null> {
    try {
      const resp = await getSharedClient().post(url, JSON.stringify(jsonData), {
        headers: {
          ...(headers ?? this.header),
          'Content-Type': 'application/json',
        },
      });
      if (resp.status >= 400) {
        logger.warn(`Cannot connect to ${url}.`);
        return null;
      }
      return toRawResponse(resp);
    } catch {
      logger.warn(`Cannot connect to ${url}.`);
      return null;
    }
  }
}
