/**
 * Environment self-checks — 1:1 port of module/checker/checker.py.
 */
import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { checkDatabase as dbCheck } from '../database/database';
import { lazyRequire } from '../utils/lazy';
import { versionCheck } from '../update/version-check';

const logger = new Logger('Checker');

export class Checker {
  static checkRenamer(): boolean {
    return settings.data.bangumi_manage.enable;
  }

  static checkAnalyser(): boolean {
    return settings.data.rss_parser.enable;
  }

  static checkFirstRun(): boolean {
    if (fs.existsSync('config/.setup_complete')) {
      return false;
    }
    // 与 Python 相同语义：无哨兵文件且配置仍是出厂默认（Config() 全新实例）
    // → 首跑。注意 DEFAULT_SETTINGS 里 security.mcp_whitelist 的 LAN 列表
    // 只在旧配置迁移时注入，不属于出厂默认。
    // 两侧都过一遍 JSON round-trip：zod 的 .nullish() 产生 undefined 属性，
    // 落盘/读盘后变成 null——不规范化深度比较永远不等，首跑判定会失效。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ConfigSchema } = require('../config/config.schema') as typeof import('../config/config.schema');
    const normalize = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;
    return isDeepStrictEqual(
      normalize(settings.dump()),
      normalize(ConfigSchema.parse({})),
    );
  }

  static checkVersion(): [boolean, number | null] {
    return versionCheck();
  }

  static checkDatabase(): boolean {
    return fs.existsSync('data/data.db') && dbCheck();
  }

  /**
   * 下载器可达性检查，附失败原因。
   * 返回 [ok, reason]；reason ∈ unreachable | credentials | banned。
   */
  static async checkDownloaderDetail(): Promise<[boolean, string | null]> {
    // Mock downloader always succeeds（与 Python 相同的短路）
    if (settings.data.downloader.type === 'mock') {
      logger.log('Using MockDownloader - skipping connection check');
      return [true, null];
    }

    let client: { withClient<T>(fn: (c: { authed: boolean }) => Promise<T>): Promise<T>; lastAuthError?: string | null } | null = null;
    try {
      interface DownloadClientCtor {
        new (): {
          withClient<T>(fn: (c: { authed: boolean }) => Promise<T>): Promise<T>;
          lastAuthError?: string | null;
        };
      }
      const { DownloadClient } = lazyRequire<{ DownloadClient: DownloadClientCtor }>(
        '../downloader/download-client',
      );
      client = new DownloadClient();
      return await client.withClient(async (dlClient) => {
        return [dlClient.authed, null] as [boolean, string | null];
      });
    } catch (e) {
      logger.error(`Downloader connect failed: ${e}`);
      const reason = client?.lastAuthError ?? 'unreachable';
      return [false, reason];
    }
  }

  static async checkDownloader(): Promise<boolean> {
    const [ok] = await Checker.checkDownloaderDetail();
    return ok;
  }

  static checkImgCache(): boolean {
    const imgPath = 'data/posters';
    if (fs.existsSync(imgPath)) {
      return true;
    }
    fs.mkdirSync(imgPath, { recursive: true });
    return false;
  }
}
