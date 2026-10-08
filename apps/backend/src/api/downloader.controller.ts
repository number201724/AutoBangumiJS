/**
 * /api/v1/downloader — 1:1 port of module/api/downloader.py.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { db } from '../database/facade';
import {
  buildSavePathIndex,
  matchBangumiInList,
  normalizeSavePath,
} from '../database/repos/bangumi';
import { DownloadClient } from '../downloader/download-client';
import { AuthGuard } from '../security/api';
import { toApiIso } from '../utils/time';

import { Logger } from '@nestjs/common';
import { StrictIntPipe } from './pipes';

const logger = new Logger('DownloaderAPI');

@Controller('/api/v1/downloader')
@UseGuards(AuthGuard)
export class DownloaderController {
  @Get('/torrents')
  async getTorrents() {
    return new DownloadClient().withClient((client) =>
      client.getTorrentInfo('Bangumi', null),
    );
  }

  /** List durable media rename conflicts awaiting user action. */
  @Get('/rename-conflicts')
  getRenameConflicts() {
    const rows = db.rename_operation.listConflicts();
    return rows.map((r) => ({
      ...r,
      created_at: toApiIso(r.created_at),
      updated_at: toApiIso(r.updated_at),
      retry_at: toApiIso(r.retry_at),
      lease_expires_at: toApiIso(r.lease_expires_at),
      notified_at: toApiIso(r.notified_at),
    }));
  }

  /** Clear one terminal conflict so the next rename pass revalidates it. */
  @Post('/rename-conflicts/:operation_id/retry')
  @HttpCode(200)
  retryRenameConflict(@Param('operation_id', StrictIntPipe) operationId: number) {
    const row = db.rename_operation.get(operationId);
    if (!row) {
      throw new HttpException('Rename conflict not found', 404);
    }
    if (row.state !== 'conflict' || row.kind !== 'conflict') {
      throw new HttpException(
        'Only non-destructive terminal conflicts can be retried; replacement recovery state must be preserved',
        409,
      );
    }
    db.rename_operation.delete(operationId);
    return {
      status: true,
      msg_en: 'Rename conflict cleared; it will be revalidated',
      msg_zh: '重命名冲突已清除，将在下一轮重新校验',
    };
  }

  @Post('/torrents/pause')
  @HttpCode(200)
  async pauseTorrents(@Body() req: { hashes: string[] }) {
    const hashes = req.hashes.join('|');
    await new DownloadClient().withClient((client) => client.pauseTorrent(hashes));
    return { msg_en: 'Torrents paused', msg_zh: '种子已暂停' };
  }

  @Post('/torrents/resume')
  @HttpCode(200)
  async resumeTorrents(@Body() req: { hashes: string[] }) {
    const hashes = req.hashes.join('|');
    await new DownloadClient().withClient((client) => client.resumeTorrent(hashes));
    return { msg_en: 'Torrents resumed', msg_zh: '种子已恢复' };
  }

  @Post('/torrents/delete')
  @HttpCode(200)
  async deleteTorrents(@Body() req: { hashes: string[]; delete_files?: boolean }) {
    const hashes = req.hashes.join('|');
    const ok = await new DownloadClient().withClient((client) =>
      client.deleteTorrent(hashes, req.delete_files ?? false),
    );
    if (!ok) {
      return { status: false, msg_en: 'Failed to delete torrents', msg_zh: '删除种子失败' };
    }
    return { status: true, msg_en: 'Torrents deleted', msg_zh: '种子已删除' };
  }

  /** Tag a torrent with a bangumi ID (ab:ID) for accurate offset lookup. */
  @Post('/torrents/tag')
  @HttpCode(200)
  async tagTorrent(@Body() req: { hash: string; bangumi_id: number }) {
    const bangumi = db.bangumi.searchId(req.bangumi_id);
    if (!bangumi) {
      return {
        status: false,
        msg_en: `Bangumi ${req.bangumi_id} not found`,
        msg_zh: `未找到番剧 ${req.bangumi_id}`,
      };
    }
    const tag = `ab:${req.bangumi_id}`;
    await new DownloadClient().withClient((client) => client.addTag(req.hash, tag));
    return {
      status: true,
      msg_en: `Tagged torrent with ${tag}`,
      msg_zh: `已为种子添加标签 ${tag}`,
    };
  }

  /** Auto-tag untagged Bangumi torrents based on name/path matching. */
  @Post('/torrents/tag/auto')
  @HttpCode(200)
  async autoTagTorrents() {
    let taggedCount = 0;
    const unmatched: Array<{ hash: string; name: string; save_path: string }> = [];

    // Load the bangumi list once and match in memory
    const bangumiList = db.bangumi.searchAll();
    const savePathIndex = buildSavePathIndex(bangumiList);

    await new DownloadClient().withClient(async (client) => {
      const torrents = await client.getTorrentInfo('Bangumi', null);
      for (const torrent of torrents) {
        const torrentHash = String(torrent.hash);
        const torrentName = String(torrent.name);
        const savePath = String(torrent.save_path);
        const tags = String(torrent.tags ?? '');

        // 必须精确匹配数字 id：ab:renamed 等同前缀标签不代表已关联番剧
        if (/ab:\d+/.test(tags)) {
          continue;
        }

        let bangumi = matchBangumiInList(torrentName, bangumiList);
        if (!bangumi) {
          bangumi = savePathIndex.get(normalizeSavePath(savePath));
        }

        if (bangumi && !bangumi.deleted) {
          const tag = `ab:${bangumi.id}`;
          await client.addTag(torrentHash, tag);
          taggedCount += 1;
          logger.log(
            `Tagged '${torrentName.slice(0, 50)}...' with ${tag} (matched: ${bangumi.official_title})`,
          );
        } else {
          unmatched.push({ hash: torrentHash, name: torrentName, save_path: savePath });
        }
      }
    });

    return {
      status: true,
      tagged_count: taggedCount,
      unmatched_count: unmatched.length,
      unmatched: unmatched.slice(0, 10),
      msg_en: `Tagged ${taggedCount} torrents, ${unmatched.length} could not be matched`,
      msg_zh: `已标记 ${taggedCount} 个种子，${unmatched.length} 个无法匹配`,
    };
  }
}
