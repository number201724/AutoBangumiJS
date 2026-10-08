/**
 * /api/v1/setup — 1:1 port of module/api/setup.py (first-run wizard).
 * Includes the SSRF guards and the default-admin authorization check.
 */
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import axios from 'axios';
import ipaddr from 'ipaddr.js';

import { authService } from '../composition';
import { VERSION } from '../version';
import { settings } from '../config/settings';
import { ConfigSchema } from '../config/config.schema';
import { db } from '../database/facade';
import { RequestContent } from '../network/request-contents';
import { rssChannelTitle, type XmlDoc } from '../network/site/mikan';
import { PROVIDER_REGISTRY } from '../notification/providers';
import { CredentialKind, resolvePrincipal } from '../security/api';
import { verifyPassword } from '../security/password';
import { getContext } from '../core/runtime';
import { isDeepStrictEqual } from 'node:util';
import { validatePassword, validateUsername } from './validators';
import { lazyRequire } from '../utils/lazy';

import { Logger } from '@nestjs/common';

const logger = new Logger('SetupAPI');

const SENTINEL_PATH = 'config/.setup_complete';

/** Guard: raise 403 if setup is already completed. */
function requireSetupNeeded(): void {
  if (fs.existsSync(SENTINEL_PATH)) {
    throw new HttpException('Setup already completed.', 403);
  }
  // Allow setup in dev mode even if settings differ
  if (
    VERSION !== 'DEV_VERSION' &&
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(settings.dump())),
      JSON.parse(JSON.stringify(ConfigSchema.parse({}))),
    )
  ) {
    throw new HttpException('Setup already completed.', 403);
  }
}

/**
 * Extra guard for /setup/complete: allow completion only if the caller has a
 * valid session, or the "admin" account still has the factory-default
 * password. Returns the stable database user ID.
 */
async function requireDefaultAdminOrAuthenticated(req: Request): Promise<number> {
  let principal;
  try {
    principal = await resolvePrincipal(req);
  } catch (e) {
    if (req.headers.authorization) throw e;
    principal = null;
  }
  if (principal) {
    if (principal.kind === CredentialKind.SESSION) {
      if (!principal.user) {
        throw new HttpException('Invalid setup session', 403);
      }
      return principal.user.id;
    }
    if (principal.kind !== CredentialKind.DEVELOPMENT || req.headers.authorization) {
      throw new HttpException('A browser session is required to authorize setup', 403);
    }
  }

  const user = db.user.findUser('admin');
  if (!user) {
    throw new HttpException('Setup administrator is not available.', 403);
  }
  if (!verifyPassword('adminadmin', user.password)) {
    throw new HttpException('Setup already completed.', 403);
  }
  return user.id;
}

/** Reject non-HTTP schemes and URLs without a hostname. */
function validateScheme(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpException('Only http/https URLs are allowed.', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpException('Only http/https URLs are allowed.', 400);
  }
  if (!parsed.hostname) {
    throw new HttpException('Invalid URL: no hostname.', 400);
  }
}

/** ipaddress.is_private/is_reserved/is_loopback equivalent on ipaddr.js ranges. */
function isDisallowedIp(ip: string): boolean {
  try {
    const addr = ipaddr.parse(ip);
    const range: string = addr.range();
    if (addr.kind() === 'ipv4') {
      return ['private', 'loopback', 'linkLocal', 'reserved'].includes(range);
    }
    return ['loopback', 'linkLocal', 'uniqueLocal', 'reserved', 'unspecified'].includes(range);
  } catch {
    return true;
  }
}

/** Reject non-HTTP schemes and private/reserved/loopback IPs. */
async function validateUrl(url: string): Promise<void> {
  validateScheme(url);
  const hostname = new URL(url).hostname;
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new HttpException('Cannot resolve hostname.', 400);
  }
  for (const { address } of addrs) {
    if (isDisallowedIp(address)) {
      throw new HttpException('URLs pointing to private/reserved IPs are not allowed.', 400);
    }
  }
}

interface TestResult {
  success: boolean;
  message_en: string;
  message_zh: string;
  title?: string | null;
  item_count?: number | null;
}

@Controller('/api/v1/setup')
export class SetupController {
  /** Check whether the setup wizard is needed. */
  @Get('/status')
  getSetupStatus() {
    let needSetup: boolean;
    if (VERSION === 'DEV_VERSION') {
      needSetup = !fs.existsSync(SENTINEL_PATH);
    } else {
      needSetup =
        !fs.existsSync(SENTINEL_PATH) &&
        isDeepStrictEqual(
          JSON.parse(JSON.stringify(settings.dump())),
          JSON.parse(JSON.stringify(ConfigSchema.parse({}))),
        );
    }
    return { need_setup: needSetup, version: VERSION };
  }

  /** Test connection to the download client. */
  @Post('/test-downloader')
  @HttpCode(200)
  async testDownloader(
    @Body()
    req: {
      type?: string;
      host: string;
      username: string;
      password: string;
      ssl?: boolean;
    },
  ): Promise<TestResult> {
    requireSetupNeeded();
    const type = req.type ?? 'qbittorrent';

    if (type === 'mock') {
      return { success: true, message_en: 'Mock downloader enabled.', message_zh: '已启用模拟下载器。' };
    }

    const scheme = req.ssl ? 'https' : 'http';
    const host = req.host.includes('://') ? req.host : `${scheme}://${req.host}`;
    // Private/loopback IPs stay allowed (LAN NAS), but only http/https (#1041)
    validateScheme(host);

    try {
      if (type === 'aria2') {
        // aria2 走 JSON-RPC：getVersion 一次验证可达性与 RPC secret
        const params = req.password ? [`token:${req.password}`] : [];
        const rpcResp = await axios.post(
          `${host}/jsonrpc`,
          { jsonrpc: '2.0', id: 'ab-setup', method: 'aria2.getVersion', params },
          { timeout: 5000, validateStatus: () => true },
        );
        const payload = typeof rpcResp.data === 'object' && rpcResp.data !== null ? rpcResp.data : {};
        if (rpcResp.status === 200 && 'result' in payload) {
          const version = String((payload as { result?: { version?: string } }).result?.version ?? '');
          return {
            success: true,
            message_en: `Connected to aria2 ${version}.`.trim(),
            message_zh: `已连接 aria2 ${version}。`,
          };
        }
        return {
          success: false,
          message_en: 'aria2 is reachable but rejected the request (check the RPC secret).',
          message_zh: 'aria2 可达但拒绝了请求（请检查 RPC secret）。',
        };
      }

      // Check if host is reachable and is qBittorrent
      const resp = await axios.get(host, {
        timeout: 5000,
        validateStatus: () => true,
        responseType: 'text',
      });
      const body = String(resp.data).toLowerCase();
      if (!body.includes('qbittorrent') && !body.includes('vuetorrent')) {
        return {
          success: false,
          message_en: 'Host is reachable but does not appear to be qBittorrent.',
          message_zh: '主机可达但似乎不是 qBittorrent。',
        };
      }

      // Try to authenticate
      const loginResp = await axios.post(
        `${host}/api/v2/auth/login`,
        new URLSearchParams({ username: req.username, password: req.password }).toString(),
        {
          timeout: 5000,
          validateStatus: () => true,
          responseType: 'text',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );
      // qBittorrent < 5.2 answers 200 + "Ok."; >= 5.2 answers 204 (#1044)
      const loginBody = String(loginResp.data).toLowerCase();
      if (loginResp.status === 204 || (loginResp.status === 200 && loginBody.includes('ok'))) {
        return { success: true, message_en: 'Connection successful.', message_zh: '连接成功。' };
      }
      if (loginResp.status === 403) {
        return {
          success: false,
          message_en: 'Authentication failed: IP is banned by qBittorrent.',
          message_zh: '认证失败：IP 被 qBittorrent 封禁。',
        };
      }
      return {
        success: false,
        message_en: 'Authentication failed: incorrect username or password.',
        message_zh: '认证失败：用户名或密码错误。',
      };
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.name === 'AxiosError' && err.code === 'ECONNABORTED') {
        return { success: false, message_en: 'Connection timed out.', message_zh: '连接超时。' };
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH') {
        return { success: false, message_en: 'Cannot connect to the host.', message_zh: '无法连接到主机。' };
      }
      // 该端点认证前可达，原始错误不能回显（#1041）
      logger.error(`Downloader test failed: ${e}`);
      return { success: false, message_en: 'Connection failed.', message_zh: '连接失败。' };
    }
  }

  /** Test an RSS feed URL. */
  @Post('/test-rss')
  @HttpCode(200)
  async testRss(@Body() req: { url: string }): Promise<TestResult> {
    requireSetupNeeded();
    await validateUrl(req.url);

    try {
      const request = new RequestContent();
      const soup: XmlDoc | null = await request.getXml(req.url);
      if (soup === null) {
        return {
          success: false,
          message_en: 'Failed to fetch or parse the RSS feed.',
          message_zh: '无法获取或解析 RSS 源。',
        };
      }
      const titleText = rssChannelTitle(soup);
      const { rssParser } = await import('../network/site/mikan');
      const items = rssParser(soup);
      return {
        success: true,
        message_en: 'RSS feed is valid.',
        message_zh: 'RSS 源有效。',
        title: titleText,
        item_count: items.length,
      };
    } catch (e) {
      logger.error(`RSS test failed: ${e}`);
      return { success: false, message_en: 'Failed to fetch RSS feed.', message_zh: '获取 RSS 源失败。' };
    }
  }

  /** Send a test notification. */
  @Post('/test-notification')
  @HttpCode(200)
  async testNotification(
    @Body() req: { type: string; token: string; chat_id?: string },
  ): Promise<TestResult> {
    requireSetupNeeded();

    const ProviderCls = PROVIDER_REGISTRY[req.type.toLowerCase()];
    if (!ProviderCls) {
      return {
        success: false,
        message_en: `Unknown notification type: ${req.type}`,
        message_zh: `未知的通知类型：${req.type}`,
      };
    }

    try {
      const provider = new ProviderCls({
        type: req.type,
        enabled: true,
        token: req.token,
        chat_id: req.chat_id ?? '',
      });
      const [success, message] = await provider.test();
      if (success) {
        return {
          success: true,
          message_en: 'Test notification sent successfully.',
          message_zh: '测试通知发送成功。',
        };
      }
      return {
        success: false,
        message_en: `Failed to send test notification: ${message}`,
        message_zh: `测试通知发送失败：${message}`,
      };
    } catch (e) {
      logger.error(`Notification test failed: ${e}`);
      return { success: false, message_en: 'Notification test failed.', message_zh: '通知测试失败。' };
    }
  }

  /** Save all wizard configuration and mark setup as complete. */
  @Post('/complete')
  @HttpCode(200)
  async completeSetup(
    @Body()
    req: {
      username: string;
      password: string;
      downloader_type?: string;
      downloader_host: string;
      downloader_username: string;
      downloader_password: string;
      downloader_path?: string;
      downloader_ssl?: boolean;
      rss_url?: string;
      rss_name?: string;
      notification_enable?: boolean;
      notification_type?: string;
      notification_token?: string;
      notification_chat_id?: string;
    },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    requireSetupNeeded();
    // SetupCompleteRequest 的 pydantic 约束：username 4-20、password ≥8，
    // downloader_* 必填——缺失/不合规即 422（FastAPI 在进 handler 前拦截）
    if (typeof req.username !== 'string' || !req.username) {
      throw new HttpException('Field required: username', 422);
    }
    if (typeof req.password !== 'string' || !req.password) {
      throw new HttpException('Field required: password', 422);
    }
    validateUsername(req.username);
    validatePassword(req.password);
    for (const f of ['downloader_host', 'downloader_username', 'downloader_password'] as const) {
      if (req[f] === undefined || req[f] === null) {
        throw new HttpException(`Field required: ${f}`, 422);
      }
    }
    const authorizedUserId = await requireDefaultAdminOrAuthenticated(request);

    try {
      // 1. Update credentials and revoke every pre-setup session. Setup does
      // not issue a replacement session: the user signs in afterwards.
      authService.updateUser(authorizedUserId, {
        username: req.username,
        password: req.password,
      });
      response.clearCookie('token', { httpOnly: true, sameSite: 'strict' });

      // 2. Update configuration
      const configDict = settings.dump() as unknown as Record<string, unknown>;
      configDict.downloader = {
        type: req.downloader_type ?? 'qbittorrent',
        host: req.downloader_host,
        username: req.downloader_username,
        password: req.downloader_password,
        path: req.downloader_path ?? '/downloads/Bangumi',
        ssl: req.downloader_ssl ?? false,
      };
      if (req.notification_enable) {
        configDict.notification = {
          enable: true,
          providers: [
            {
              type: req.notification_type ?? 'telegram',
              enabled: true,
              token: req.notification_token ?? '',
              chat_id: req.notification_chat_id ?? '',
            },
          ],
        };
      }

      settings.save(configDict as never);
      // Route through the AppContext reload path so the shared HTTP client,
      // notifier, and scheduler are rebuilt against the new config too.
      await getContext().reloadSettings();

      // 3. Add RSS feed if provided
      if (req.rss_url) {
        const { RSSEngine } = lazyRequire<{
          RSSEngine: new (db: unknown) => {
            addRss(url: string, name?: string | null): Promise<unknown>;
          };
        }>('../rss/engine');
        const engine = new RSSEngine(db);
        await engine.addRss(req.rss_url, req.rss_name || null);
      }

      // 4. Create sentinel file
      fs.mkdirSync('config', { recursive: true });
      fs.writeFileSync(SENTINEL_PATH, '');
      await getContext().startTasks();

      return {
        status: true,
        status_code: 200,
        msg_en: 'Setup completed successfully.',
        msg_zh: '设置完成。',
      };
    } catch (e) {
      logger.error(`Complete failed: ${e}`);
      return {
        status: false,
        status_code: 500,
        msg_en: 'Setup failed. Check the server log for details.',
        msg_zh: '设置失败，请查看服务器日志。',
      };
    }
  }
}
