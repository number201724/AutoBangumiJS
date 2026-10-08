/**
 * SeasonCollector + eps_complete — 1:1 port of module/manager/collector.py.
 */
import { Logger } from '@nestjs/common';

import { db as sharedDb, type Database } from '../database/facade';
import { releaseFitsBangumi, type BangumiRow, type NewBangumiRow } from '../database/repos/bangumi';
import type { NewTorrentRow } from '../database/schema';
import { AddResult } from '../downloader/base';
import { DownloadClient } from '../downloader/download-client';
import { RequestContent, type TorrentData } from '../network/request-contents';
import { lazyRequire } from '../utils/lazy';
import type { ManagerResponse } from './torrent';

const logger = new Logger('SeasonCollector');

/**
 * 确保 data.id 可用：新番剧插入拿 id，重复番剧解析出已存在行的 id。
 * 解析到被软删除的行时会重新启用它（显式订阅/收集只能是用户想要它回来）。
 * 返回是否插入了新行（调用方据此决定失败时是否回滚删除）。
 */
async function ensureBangumiId(db: Database, data: NewBangumiRow & { id?: number }): Promise<boolean> {
  if (db.bangumi.add(data)) {
    return true;
  }
  let existing = db.bangumi.findDuplicate(data);
  if (!existing) {
    existing = db.bangumi.findSemanticDuplicate(data);
  }
  if (existing) {
    if (existing.deleted) {
      db.bangumi.restoreOne(existing.id);
    }
    data.id = existing.id;
  } else if (data.id != null && db.bangumi.searchId(data.id) === undefined) {
    data.id = undefined;
  }
  return false;
}

export class SeasonCollector {
  constructor(private readonly client: DownloadClient) {}

  async collectSeason(
    bangumi: NewBangumiRow & { id?: number },
    link?: string | null,
  ): Promise<ManagerResponse> {
    logger.log(`Start collecting ${bangumi.official_title} Season ${bangumi.season}...`);
    const { SearchTorrent } = lazyRequire<{
      SearchTorrent: new () => {
        searchSeason(b: NewBangumiRow): Promise<TorrentData[]>;
      };
    }>('../searcher/searcher');
    let torrents: TorrentData[];
    if (!link) {
      torrents = await new SearchTorrent().searchSeason(bangumi);
    } else {
      const req = new RequestContent();
      torrents = await req.getTorrents(link, bangumi.filter.split(',').join('|'));
      torrents = torrents.filter((t) => releaseFitsBangumi(t.name, bangumi as BangumiRow));
    }
    const db = sharedDb;
    // bangumi 必须先落库拿到 id：add_torrent 用它打 ab:<id> 标签，
    // 种子行也要用它关联 bangumi_id——否则种子会被记成孤儿。
    let inserted = false;
    const updateOk =
      bangumi.id != null ? db.bangumi.update({ ...bangumi, id: bangumi.id }) : false;
    if (!updateOk) {
      inserted = await ensureBangumiId(db, bangumi);
    } else {
      // 载荷带着已禁用行的 id 也能 update 成功：显式收集即用户想重新启用
      db.bangumi.restoreOne(bangumi.id!);
    }
    const result = await this.client.addTorrent(torrents as TorrentData[], bangumi as never);
    if (result === AddResult.ADDED) {
      logger.log(`Collections of ${bangumi.official_title} Season ${bangumi.season} completed.`);
      const rows: NewTorrentRow[] = torrents.map((t) => ({
        ...t,
        downloaded: true,
        bangumi_id: bangumi.id ?? null,
      }));
      bangumi.eps_collect = true;
      // 只更新 eps_collect 单个字段：整行 update 会用默认值覆盖用户调好的 offset/filter
      if (bangumi.id != null) {
        db.bangumi.markEpsCollect(bangumi.id);
        // addTorrent 里 gen_save_path 的写入持久化（Python session commit 语义）
        if (bangumi.save_path) {
          db.bangumi.update({ id: bangumi.id, save_path: bangumi.save_path });
        }
      }
      db.torrent.addAll(rows);
      return {
        status: true,
        status_code: 200,
        msg_en: `Collections of ${bangumi.official_title} Season ${bangumi.season} completed.`,
        msg_zh: `收集 ${bangumi.official_title} 第 ${bangumi.season} 季完成。`,
      };
    }
    if (inserted && bangumi.id != null) {
      // 收集失败时回滚刚插入的行，不留下幽灵订阅规则
      db.bangumi.deleteOne(bangumi.id);
      bangumi.id = undefined;
    }
    logger.warn(`Already collected ${bangumi.official_title} Season ${bangumi.season}.`);
    return {
      status: false,
      status_code: 406,
      msg_en: `Collection of ${bangumi.official_title} Season ${bangumi.season} failed.`,
      msg_zh: `收集 ${bangumi.official_title} 第 ${bangumi.season} 季失败, 种子已经添加。`,
    };
  }

  static async subscribeSeason(data: NewBangumiRow & { id?: number }, parser = 'mikan'): Promise<ManagerResponse> {
    const db = sharedDb;
    const { RSSEngine } = await import('../rss/engine');
    const engine = new RSSEngine(db);
    data.added = true;
    data.eps_collect = true;
    await engine.addRss(data.rss_link, data.official_title, false, parser);
    // 先落库拿到 id（重复订阅时解析已存在行的 id）
    await ensureBangumiId(db, data);
    return engine.downloadBangumi(data as BangumiRow);
  }
}

export async function epsComplete(): Promise<void> {
  const db = sharedDb;
  const datas = db.bangumi.notComplete();
  if (datas.length) {
    logger.log('Start collecting full season...');
    await new DownloadClient().withClient(async (client) => {
      const collector = new SeasonCollector(client);
      for (const data of datas) {
        if (!data.eps_collect) {
          await collector.collectSeason(data);
        }
        data.eps_collect = true;
      }
    });
    db.bangumi.updateAll(datas);
  }
}
