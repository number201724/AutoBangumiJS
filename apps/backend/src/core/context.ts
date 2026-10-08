/**
 * AppContext — 1:1 port of module/core/context.py (application composition root).
 *
 * Owns settings, the notification manager, the scheduler, and the downloader
 * status TTL cache; orchestrates startup/shutdown/reload.
 */
import { Logger } from '@nestjs/common';

import { Checker } from '../checker/checker';
import { VERSION } from '../version';
import { LEGACY_DATA_PATH } from '../config/constants';
import { settings, type Settings } from '../config/settings';
import { resetSharedClient } from '../network/request-url';
import { migrateLegacyAuthTokens, firstRun } from '../update/startup';
import { initDatabase } from '../database/database';
import { lazyRequire } from '../utils/lazy';
import { versionCheck } from '../update/version-check';
import { PeriodicTask, Scheduler } from './scheduler';
import * as fs from 'node:fs';

const logger = new Logger('AppContext');

// Downloader-status cache TTL, in seconds
const DOWNLOADER_STATUS_TTL = 60;

// Background loop cadence (seconds)
export const OFFSET_SCAN_INTERVAL = 6 * 60 * 60;
export const CALENDAR_REFRESH_INTERVAL = 24 * 60 * 60;
export const UPDATE_CHECK_INTERVAL = 24 * 60 * 60;
export const OFFSET_SCAN_INITIAL_DELAY = 60;
export const CALENDAR_INITIAL_DELAY = 120;
export const UPDATE_CHECK_INITIAL_DELAY = 300;

// Downloader wait-retry loop on startup
const DOWNLOADER_MAX_RETRIES = 10;
const DOWNLOADER_RETRY_INTERVAL = 30;

const figlet = String.raw`
               _        ____                                    _
    /\        | |      |  _ \                                  (_)
   /  \  _   _| |_ ___ | |_) | __ _ _ __   __ _ _   _ _ __ ___  _
  / /\ \| | | | __/ _ \|  _ < / _\` | '_ \ / _\` | | | | '_ \` _ \| |
 / ____ \ |_| | || (_) | |_) | (_| | | | | (_| | |_| | | | | | | |
/_/    \_\__,_|\__\___/|____/ \__,_|_| |_|\__, |\__,_|_| |_| |_|_|
                                           __/ |
                                          |___/
`;

export interface ResponseMsg {
  status: boolean;
  status_code: number;
  msg_en: string;
  msg_zh: string;
}

// Lazy module accessors — resolved on first use so this composition root does
// not hard-depend on engine modules (and to avoid import cycles).
function loopsModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./loops') as typeof import('./loops');
}
function notificationModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../notification/manager') as typeof import('../notification/manager');
}
function rssModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../rss/analyser') as typeof import('../rss/analyser');
}

interface DownloaderModuleLike {
  clearCredentialLatch(): void;
  shutdown(): Promise<void>;
}
function downloaderModule(): DownloaderModuleLike {
  return lazyRequire<DownloaderModuleLike>('../downloader/download-client');
}

interface NotificationEventsModuleLike {
  DownloaderUnavailableEvent: new (host: string, reason: string) => import('../notification/events').SystemEvent;
}
function notificationEventsModule(): NotificationEventsModuleLike {
  return lazyRequire<NotificationEventsModuleLike>('../notification/events');
}

export class AppContext {
  firstRunBoot = false;

  private downloaderStatus = false;
  private downloaderReason: string | null = null;
  private downloaderLastCheck = 0;
  private startupDone = false;
  private lifecycleLock: Promise<void> = Promise.resolve();
  private startTask: Promise<void> | null = null;
  private startGeneration = 0;

  private constructor(
    public readonly settingsObj: Settings,
    public readonly notifier: InstanceType<
      ReturnType<typeof notificationModule>['NotificationManager']
    >,
    public readonly scheduler: Scheduler,
    public readonly analyser: unknown,
  ) {}

  /** Pure wiring: construct the object graph, perform no I/O. */
  static build(settingsObj: Settings): AppContext {
    const { NotificationManager } = notificationModule();
    const { RSSAnalyser } = rssModule();
    const loops = loopsModule();

    const analyser = new RSSAnalyser();
    const notifier = new NotificationManager();
    const scheduler = new Scheduler([
      new PeriodicTask(
        'rss',
        () => loops.rssTick(analyser, notifier),
        () => settingsObj.data.program.rss_time,
        0,
        () => Checker.checkAnalyser(),
      ),
      new PeriodicTask(
        'rename',
        () => loops.renameTick(notifier),
        () => settingsObj.data.program.rename_time,
        0,
        () => Checker.checkRenamer(),
      ),
      new PeriodicTask(
        'offset_scan',
        () => loops.offsetScanTick(notifier),
        () => OFFSET_SCAN_INTERVAL,
        OFFSET_SCAN_INITIAL_DELAY,
      ),
      new PeriodicTask(
        'calendar',
        () => loops.calendarTick(),
        () => CALENDAR_REFRESH_INTERVAL,
        CALENDAR_INITIAL_DELAY,
      ),
      new PeriodicTask(
        'update_check',
        () => loops.updateCheckTick(notifier),
        () => UPDATE_CHECK_INTERVAL,
        UPDATE_CHECK_INITIAL_DELAY,
        () => settingsObj.data.update.auto_check,
      ),
    ]);
    return new AppContext(settingsObj, notifier, scheduler, analyser);
  }

  // ------------------------------------------------------------------ status

  get isRunning(): boolean {
    if (Checker.checkFirstRun()) return false;
    return this.scheduler.running || this.startTask !== null;
  }

  get firstRun(): boolean {
    return Checker.checkFirstRun();
  }

  /** Raw downloader reachability check (no cache), used by /check/downloader. */
  checkDownloader(): Promise<boolean> {
    return Checker.checkDownloader();
  }

  /** TTL-cached downloader reachability, used by the startup wait loop. */
  async checkDownloaderStatus(): Promise<boolean> {
    const now = Date.now() / 1000;
    if (
      !this.downloaderStatus ||
      now - this.downloaderLastCheck >= DOWNLOADER_STATUS_TTL
    ) {
      const [ok, reason] = await Checker.checkDownloaderDetail();
      this.downloaderStatus = ok;
      this.downloaderReason = reason;
      this.downloaderLastCheck = now;
    }
    return this.downloaderStatus;
  }

  // ------------------------------------------------------------------ startup

  private static startInfo(): void {
    for (const line of figlet.split('\n')) {
      logger.log(line);
    }
    logger.log(
      `Version ${VERSION}  Author: EstrellaXD Twitter: https://twitter.com/Estrella_Pan`,
    );
    logger.log('GitHub: https://github.com/EstrellaXD/Auto_Bangumi/');
    logger.log('Starting AutoBangumi...');
  }

  /** First-run detection and database migrations. Does not start tasks. */
  async startup(): Promise<void> {
    if (this.startupDone) return;
    AppContext.startInfo();
    if (!Checker.checkDatabase()) {
      await firstRun();
      migrateLegacyAuthTokens();
      logger.log('No db file exists, create database file.');
      this.firstRunBoot = true;
      this.startupDone = true;
      return;
    }
    // DB 已存在：补齐建表 + 迁移（对应 Python lifespan 外 main.py 的顺序——
    // Python 的 create_tables/run_migrations 也在 startup 内部完成）
    initDatabase();
    if (fs.existsSync(LEGACY_DATA_PATH)) {
      // 旧 data/data.json 迁移：Node 版一期不实现 3.0 数据迁移（见 docs）。
      logger.warn(
        'Legacy data/data.json detected. 3.0 data migration is not supported by ' +
          'the Node.js build yet; please run the Python version once to upgrade.',
      );
    } else {
      const [isSame, lastMinor] = versionCheck();
      if (!isSame) {
        if (lastMinor === 0) {
          logger.warn(
            'Database from 3.0 detected. 3.0->3.1 migration is not supported by ' +
              'the Node.js build yet; please run the Python version once to upgrade.',
          );
        }
        // 3.1->3.2 is exactly the table-driven migration set, already run at boot.
        logger.log('Database updated.');
      }
    }
    migrateLegacyAuthTokens();
    if (!Checker.checkImgCache()) {
      logger.log('No image cache exists, create image cache.');
      // cache_image() 海报本地化迁移在 Node 版一期不实现（旧 3.1 升级路径）
    }
    this.startupDone = true;
  }

  // ------------------------------------------------------------------ tasks

  private async waitForDownloader(gen: number): Promise<void> {
    let retryCount = 0;
    while (!(await this.checkDownloaderStatus())) {
      // stop() 已废弃本启动任务：立即退出，不再继续重试/输出噪音
      if (gen !== this.startGeneration) return;
      const reason = this.downloaderReason ?? 'unreachable';
      if (reason === 'credentials' || reason === 'banned') {
        // 凭据错误/IP 被封时等待没有意义，继续探测反而会累积失败登录、
        // 触发（或加剧）qB 的 WebUI IP ban——立即放弃并通知。
        logger.error(
          `Downloader rejected authentication (${reason}); giving up. ` +
            'Program will continue but download functions will not work.',
        );
        await this.notifyDownloaderUnavailable(reason);
        return;
      }
      retryCount += 1;
      logger.warn(
        `Downloader is not running. (attempt ${retryCount}/${DOWNLOADER_MAX_RETRIES})`,
      );
      if (retryCount >= DOWNLOADER_MAX_RETRIES) {
        logger.error(
          'Failed to connect to downloader after maximum retries. ' +
            'Please check downloader settings and network/proxy configuration. ' +
            'Program will continue but download functions will not work.',
        );
        await this.notifyDownloaderUnavailable('unreachable');
        break;
      }
      logger.log('Waiting for downloader to start...');
      await new Promise((r) => setTimeout(r, DOWNLOADER_RETRY_INTERVAL * 1000));
      // 每次重试后再确认一次代际（30s sleep 期间可能已被 stop）
      if (gen !== this.startGeneration) return;
    }
  }

  private async notifyDownloaderUnavailable(reason: string): Promise<void> {
    try {
      const { DownloaderUnavailableEvent } = notificationEventsModule();
      await this.notifier.sendEvent(
        new DownloaderUnavailableEvent(settings.data.downloader.host, reason),
      );
    } catch (e) {
      logger.warn(`Failed to emit downloader-unavailable notification: ${e}`);
    }
  }

  private async runStartTasks(gen: number): Promise<void> {
    await this.waitForDownloader(gen);
    // stop() 在等待下载器期间被调用时，本任务已被废弃——不得再 startAll
    // （Python 用 task.cancel() 中断；TS 无法取消 async fn，用代际守卫）
    if (gen !== this.startGeneration) return;
    if (!Checker.checkFirstRun() && !this.scheduler.running) {
      this.scheduler.startAll();
    }
    logger.log('Program running.');
  }

  /**
   * Kick off the downloader-wait + loop-start in the background and return
   * immediately (CONTRACT #5: the wait loop can take up to ~300s).
   */
  startTasks(): Promise<ResponseMsg> {
    return this.withLock(() => this.startTasksUnlocked());
  }

  private async startTasksUnlocked(): Promise<ResponseMsg> {
    await this.reloadSettingsUnlocked();
    if (!this.scheduler.running && this.startTask === null) {
      const gen = ++this.startGeneration;
      this.startTask = this.runStartTasks(gen)
        .catch((e) => {
          logger.error(`Background start task failed: ${e}`);
        })
        .finally(() => {
          this.startTask = null;
        });
    }
    return { status: true, status_code: 200, msg_en: 'Program starting.', msg_zh: '程序启动中。' };
  }

  /** Cancel any pending start task, stop loops, close downloader session. */
  stop(): Promise<ResponseMsg> {
    return this.withLock(() => this.stopUnlocked());
  }

  private async stopUnlocked(): Promise<ResponseMsg> {
    const wasRunning = this.isRunning;
    // 作废进行中的启动任务（等待下载器循环里的下一次重试会立即放弃 startAll）
    this.startGeneration += 1;
    this.startTask = null;
    if (this.scheduler.running) {
      await this.scheduler.stopAll();
    }
    const resp: ResponseMsg = wasRunning
      ? { status: true, status_code: 200, msg_en: 'Program stopped.', msg_zh: '程序停止成功。' }
      : { status: false, status_code: 406, msg_en: 'Program is not running.', msg_zh: '程序未运行。' };
    // Always release the shared downloader session (idempotent).
    try {
      await downloaderModule().shutdown();
    } catch (e) {
      logger.warn(`Downloader shutdown failed: ${e}`);
    }
    return resp;
  }

  restart(): Promise<ResponseMsg> {
    return this.withLock(async () => {
      let stopOk = true;
      try {
        await this.stopUnlocked();
      } catch (e) {
        logger.warn(`Error during stop in restart: ${e}`);
        stopOk = false;
      }
      let startOk = true;
      try {
        await this.startTasksUnlocked();
      } catch (e) {
        logger.error(`Error during start in restart: ${e}`);
        startOk = false;
      }
      if (startOk && stopOk) {
        return { status: true, status_code: 200, msg_en: 'Program restarted.', msg_zh: '程序重启成功。' };
      }
      if (startOk) {
        return {
          status: true,
          status_code: 200,
          msg_en: 'Program restarted (stop had warnings).',
          msg_zh: '程序重启成功（停止时有警告）。',
        };
      }
      return {
        status: false,
        status_code: 500,
        msg_en: 'Program failed to restart.',
        msg_zh: '程序重启失败。',
      };
    });
  }

  // ------------------------------------------------------------------ reload

  /**
   * Single choreography for a config update: reload + re-apply live state.
   * This is the ONLY place settings are reloaded from disk.
   */
  reloadSettings(): Promise<void> {
    return this.withLock(() => this.reloadSettingsUnlocked());
  }

  private async reloadSettingsUnlocked(): Promise<void> {
    settings.load();
    resetSharedClient();
    // Endpoint-keyed caches must be dropped too, or a changed
    // tmdb_base_url/bgm_base_url keeps serving results from the old endpoint.
    try {
      lazyRequire<{ resetCache(): void }>('../parser/tmdb-parser').resetCache();
    } catch {
      /* parser module not ready */
    }
    try {
      lazyRequire<{ resetCache(): void }>('../parser/mikan-parser').resetCache();
    } catch {
      /* parser module not ready */
    }
    try {
      lazyRequire<{ resetCache(): void }>('../searcher/searcher').resetCache();
    } catch {
      /* searcher module not ready */
    }
    try {
      lazyRequire<{ resetCache(): void }>('../parser/title-parser').resetCache();
    } catch {
      /* parser module not ready */
    }
    // 用户保存了设置即视为已处理凭据问题：解除下载器的凭据失败闩锁
    try {
      downloaderModule().clearCredentialLatch();
    } catch {
      /* downloader module not ready */
    }
    this.notifier.rebuild();
    if (this.scheduler.running) {
      await this.scheduler.stopAll();
      this.scheduler.startAll();
    }
  }

  /** Serialize lifecycle mutations (asyncio.Lock equivalent). */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleLock;
    let release!: () => void;
    this.lifecycleLock = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
