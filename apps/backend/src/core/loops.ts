/**
 * Periodic task tick bodies — 1:1 port of module/core/loops.py.
 *
 * Engine modules are lazily require()d: the composition root (context.ts)
 * imports this file at graph-build time, before heavy modules are ready, and
 * lazy resolution also avoids the core -> rss/downloader import cycles.
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { db } from '../database/facade';
import { lazyRequire } from '../utils/lazy';

const logger = new Logger('Loops');

interface DownloadClientLike {
  withClient<T>(fn: (client: unknown) => Promise<T>): Promise<T>;
}
interface DownloaderModuleLike {
  DownloadClient: new () => DownloadClientLike;
}
function downloaderModule(): DownloaderModuleLike {
  return lazyRequire<DownloaderModuleLike>('../downloader/download-client');
}
function rssModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../rss/engine') as typeof import('../rss/engine');
}
function managerModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../manager') as typeof import('../manager');
}
function offsetScannerModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./offset-scanner') as typeof import('./offset-scanner');
}

interface NotifierLike {
  sendEvent(event: unknown): Promise<void>;
  sendAll(info: unknown): Promise<void>;
}

/** Analyse aggregate RSS feeds and refresh the RSS engine once. */
export async function rssTick(analyser: unknown, notifier: NotifierLike): Promise<void> {
  const { DownloadClient } = downloaderModule();
  const { RSSEngine } = rssModule();
  await new DownloadClient().withClient(async (client: unknown) => {
    const engine = new RSSEngine(db);
    // Analyse RSS
    const rssList = db.rss.searchAggregate();
    for (const rss of rssList) {
      try {
        await (analyser as { rssToData(r: unknown, e: unknown): Promise<void> }).rssToData(rss, engine);
      } catch (e) {
        // 仅当该 RSS 确实已在遍历期间被 API 删除时才视为预期情况
        if (db.rss.searchId(rss.id) === undefined) {
          logger.debug(`Skipping RSS id=${rss.id}, deleted during iteration`);
        } else {
          logger.warn(`Error analysing RSS id=${rss.id} (${rss.url}): ${(e as Error).stack ?? e}`);
        }
      }
    }
    // Run RSS Engine
    return (engine as { refreshRss(c: unknown): Promise<unknown[]> }).refreshRss(client as never);
  }).then(async (events: unknown[]) => {
    if (events && events.length) {
      // send_event 内部先落库通知中心再按开关外发；事件间也并行（#1026）
      await Promise.all(events.map((e) => notifier.sendEvent(e)));
    }
  });
  if (settings.data.bangumi_manage.eps_complete) {
    await managerModule().epsComplete();
  }
}

/** Rename completed downloads and notify via the shared notifier. */
export async function renameTick(notifier: NotifierLike): Promise<void> {
  const { DownloadClient } = downloaderModule();
  const { Renamer } = managerModule();
  const { renamedInfo, events } = await new DownloadClient().withClient(async (client: unknown) => {
    const renamer = new Renamer(client as never);
    const renamedInfo = await renamer.rename();
    return { renamedInfo, events: [...renamer.events] };
  });
  if (events.length) {
    await Promise.all(events.map((e: unknown) => notifier.sendEvent(e)));
  }
  if (settings.data.notification.enable && renamedInfo.length) {
    // 批量改名（如整季首次导入）不应串行 N 次通知往返
    await Promise.all(renamedInfo.map((info: unknown) => notifier.sendAll(info)));
  }
}

/** Scan all bangumi for season/episode offset mismatches. */
export async function offsetScanTick(notifier: NotifierLike): Promise<void> {
  const { OffsetScanner } = offsetScannerModule();
  const scanner = new OffsetScanner();
  const events = (await scanner.scanAll()) as unknown[];
  if (events.length) {
    await Promise.all(events.map((e) => notifier.sendEvent(e)));
  }
}

/**
 * 每日检查一次 GitHub Release，发现新版本时写入通知中心。
 * 在线更新模块在 Node 版为二期；checkUpdate 未就绪时静默跳过。
 */
export async function updateCheckTick(notifier: NotifierLike): Promise<void> {
  let updater: typeof import('../update/updater');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    updater = require('../update/updater');
  } catch {
    logger.debug('Update checker not available in this build');
    return;
  }
  const result = await updater.checkUpdate(settings.data.update.channel, false);
  if (result.error) {
    logger.debug(`Update check failed: ${result.error}`);
    return;
  }
  if (!result.has_update) return;
  interface UpdateAvailableEventCtor {
    new (current: string, latest: string, channel: string, notes?: string): unknown;
  }
  const { UpdateAvailableEvent } = lazyRequire<{ UpdateAvailableEvent: UpdateAvailableEventCtor }>(
    '../notification/events',
  );
  await notifier.sendEvent(
    new UpdateAvailableEvent(
      result.current,
      result.latest ?? '',
      result.channel,
      result.notes ?? '',
    ),
  );
}

/** Refresh bangumi calendar metadata. */
export async function calendarTick(): Promise<void> {
  const { TorrentManager } = managerModule();
  const manager = new TorrentManager(db);
  const resp = await manager.refreshCalendar();
  // 成功已由 TorrentManager.refreshCalendar 记录（含更新数量）
  if (!resp.status) {
    logger.warn(`Calendar refresh failed: ${resp.msg_en}`);
  }
}
