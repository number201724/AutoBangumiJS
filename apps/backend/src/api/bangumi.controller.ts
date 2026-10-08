/**
 * /api/v1/bangumi — 1:1 port of module/api/bangumi.py.
 *
 * Route order note: literal paths (/delete/many, /torrents/orphans...) are
 * declared before parameterized ones so they are never captured as an id.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { StrictIntPipe, parseBoolQuery } from './pipes';
import type { Response } from 'express';

import { settings } from '../config/settings';
import { db } from '../database/facade';
import { DownloadClient } from '../downloader/download-client';
import { Renamer, TorrentManager, type ManagerResponse } from '../manager';
import { AuthGuard } from '../security/api';
import { lazyRequire } from '../utils/lazy';
import { uResponse } from './response';
import type { BangumiRow, NewBangumiRow } from '../database/schema';

function emptyIdListResponse(res: Response): void {
  uResponse(res, {
    status_code: 400,
    msg_en: 'No bangumi id provided.',
    msg_zh: '未提供番剧 id。',
  });
}

function aggregateResponse(res: Response, actionEn: string, actionZh: string, results: ManagerResponse[]): void {
  const succeeded = results.filter((r) => r.status).length;
  const allOk = succeeded === results.length;
  uResponse(res, {
    status_code: allOk ? 200 : 500,
    msg_en: `${actionEn} ${succeeded}/${results.length} rules.`,
    msg_zh: `已${actionZh} ${succeeded}/${results.length} 条规则。`,
  });
}

/** Run a rename pass so applied offsets take effect immediately. */
async function triggerRename(): Promise<void> {
  await new DownloadClient().withClient(async (client) => {
    const renamer = new Renamer(client);
    await renamer.rename();
  });
}

@Controller('/api/v1/bangumi')
@UseGuards(AuthGuard)
export class BangumiController {
  private readonly manager = new TorrentManager(db);

  @Get('/get/all')
  getAllData() {
    return db.bangumi.searchAll();
  }

  @Get('/get/:bangumi_id')
  async getData(@Param('bangumi_id', StrictIntPipe) bangumiId: number, @Res() res: Response) {
    const resp = await this.manager.searchOne(bangumiId);
    if ('status_code' in (resp as ManagerResponse)) {
      uResponse(res, resp as ManagerResponse);
      return;
    }
    res.json(resp);
  }

  @Patch('/update/:bangumi_id')
  async updateRule(
    @Param('bangumi_id', StrictIntPipe) bangumiId: number,
    @Body() data: Partial<NewBangumiRow>,
    @Res() res: Response,
  ) {
    uResponse(res, await this.manager.updateRule(bangumiId, data));
  }

  // Registered before /delete/:bangumi_id so "many" is never captured as an id.
  @Post('/delete/many')
  @HttpCode(200)
  async deleteManyRule(
    @Body() ids: number[],
    @Query('file') file: string | undefined,
    @Res() res: Response,
  ) {
    if (!Array.isArray(ids) || !ids.length) return emptyIdListResponse(res);
    const fileFlag = parseBoolQuery(file);
    const results: ManagerResponse[] = [];
    for (const i of ids) {
      results.push(await this.manager.deleteRule(i, fileFlag));
    }
    aggregateResponse(res, 'Deleted', '删除', results);
  }

  @Delete('/delete/:bangumi_id')
  async deleteRule(
    @Param('bangumi_id', StrictIntPipe) bangumiId: number,
    @Query('file') file: string | undefined,
    @Res() res: Response,
  ) {
    uResponse(res, await this.manager.deleteRule(bangumiId, parseBoolQuery(file)));
  }

  @Post('/disable/many')
  @HttpCode(200)
  async disableManyRule(
    @Body() ids: number[],
    @Query('file') file: string | undefined,
    @Res() res: Response,
  ) {
    if (!Array.isArray(ids) || !ids.length) return emptyIdListResponse(res);
    const fileFlag = parseBoolQuery(file);
    const results: ManagerResponse[] = [];
    for (const i of ids) {
      results.push(await this.manager.disableRule(i, fileFlag));
    }
    aggregateResponse(res, 'Disabled', '禁用', results);
  }

  @Post('/disable/:bangumi_id')
  @HttpCode(200)
  async disableRule(
    @Param('bangumi_id', StrictIntPipe) bangumiId: number,
    @Query('file') file: string | undefined,
    @Res() res: Response,
  ) {
    uResponse(res, await this.manager.disableRule(bangumiId, parseBoolQuery(file)));
  }

  @Post('/enable/:bangumi_id')
  @HttpCode(200)
  async enableRule(@Param('bangumi_id', StrictIntPipe) bangumiId: number, @Res() res: Response) {
    uResponse(res, await this.manager.enableRule(bangumiId));
  }

  @Get('/refresh/poster/all')
  async refreshPosterAll(@Res() res: Response) {
    uResponse(res, await this.manager.refreshPoster());
  }

  @Get('/refresh/poster/:bangumi_id')
  async refreshPosterOne(@Param('bangumi_id', StrictIntPipe) bangumiId: number, @Res() res: Response) {
    uResponse(res, await this.manager.refindPoster(bangumiId));
  }

  @Get('/refresh/calendar')
  async refreshCalendar(@Res() res: Response) {
    uResponse(res, await this.manager.refreshCalendar());
  }

  @Post('/reset/all')
  @HttpCode(200)
  resetAll() {
    db.bangumi.deleteAll();
    return { msg_en: 'Reset all rules successfully.', msg_zh: '重置所有规则成功。' };
  }

  @Patch('/archive/:bangumi_id')
  async archiveRule(@Param('bangumi_id', StrictIntPipe) bangumiId: number, @Res() res: Response) {
    uResponse(res, await this.manager.archiveRule(bangumiId));
  }

  @Patch('/unarchive/:bangumi_id')
  async unarchiveRule(@Param('bangumi_id', StrictIntPipe) bangumiId: number, @Res() res: Response) {
    uResponse(res, await this.manager.unarchiveRule(bangumiId));
  }

  @Get('/refresh/metadata')
  async refreshMetadata(@Res() res: Response) {
    uResponse(res, await this.manager.refreshMetadata());
  }

  /** Suggest offset based on TMDB episode counts. */
  @Get('/suggest-offset/:bangumi_id')
  async suggestOffset(@Param('bangumi_id', StrictIntPipe) bangumiId: number) {
    return this.manager.suggestOffset(bangumiId);
  }

  /** Detect season/episode mismatch with TMDB data (pre-subscribe check). */
  @Post('/detect-offset')
  @HttpCode(200)
  async detectOffset(@Body() request: { title: string; parsed_season: number; parsed_episode: number }) {
    const { tmdbParser } = lazyRequire<{
      tmdbParser(title: string, language: string): Promise<{
        title: string;
        last_season: number;
        season_episode_counts: Record<number, number>;
        series_status: string | null;
        virtual_season_starts: Record<number, number[]> | null;
      } | null>;
    }>('../parser/tmdb-parser');
    const { detectOffsetMismatch } = lazyRequire<{
      detectOffsetMismatch(
        parsedSeason: number,
        parsedEpisode: number,
        tmdbInfo: unknown,
      ): {
        season_offset: number;
        episode_offset: number | null;
        reason: string;
        confidence: 'high' | 'medium' | 'low';
      } | null;
    }>('../parser/offset-detector');

    const language = settings.data.rss_parser.language;
    const tmdbInfo = await tmdbParser(request.title, language);

    if (!tmdbInfo) {
      return { has_mismatch: false, suggestion: null, tmdb_info: null };
    }

    const suggestion = detectOffsetMismatch(
      request.parsed_season,
      request.parsed_episode,
      tmdbInfo,
    );

    const tmdbSummary = {
      title: tmdbInfo.title,
      total_seasons: tmdbInfo.last_season,
      season_episode_counts: tmdbInfo.season_episode_counts ?? {},
      status: tmdbInfo.series_status,
      virtual_season_starts: tmdbInfo.virtual_season_starts,
    };

    if (suggestion) {
      return {
        has_mismatch: true,
        suggestion: {
          season_offset: suggestion.season_offset,
          // None means "no episode offset needed" (see offset_detector)
          episode_offset: suggestion.episode_offset ?? 0,
          reason: suggestion.reason,
          confidence: suggestion.confidence,
        },
        tmdb_info: tmdbSummary,
      };
    }
    return { has_mismatch: false, suggestion: null, tmdb_info: tmdbSummary };
  }

  /** Clear the needs_review flag after user review. */
  @Post('/dismiss-review/:bangumi_id')
  @HttpCode(200)
  dismissReview(@Param('bangumi_id', StrictIntPipe) bangumiId: number, @Res() res: Response) {
    const success = db.bangumi.clearNeedsReview(bangumiId);
    if (success) {
      res.json({ status: true, msg_en: 'Review dismissed.', msg_zh: '已取消检查标记。' });
    } else {
      res.status(404).json({
        status: false,
        msg_en: `Bangumi ${bangumiId} not found.`,
        msg_zh: `未找到番剧 ${bangumiId}。`,
      });
    }
  }

  // Registered before /apply-offset/:bangumi_id so "many" is never captured.
  @Post('/apply-offset/many')
  @HttpCode(200)
  async applyOffsetMany(@Body() ids: number[], @Res() res: Response) {
    if (!Array.isArray(ids) || !ids.length) return emptyIdListResponse(res);
    const results = ids.map((i) => db.bangumi.applyOffset(i));
    const succeeded = results.filter(Boolean).length;
    if (succeeded) {
      await triggerRename();
    }
    const allOk = succeeded === results.length;
    uResponse(res, {
      status_code: allOk ? 200 : 500,
      msg_en: `Applied offset for ${succeeded}/${results.length} bangumi.`,
      msg_zh: `已为 ${succeeded}/${results.length} 部番剧应用偏移量。`,
    });
  }

  /** Apply the suggested season/episode offset and trigger a rename pass. */
  @Post('/apply-offset/:bangumi_id')
  @HttpCode(200)
  async applyOffset(@Param('bangumi_id', StrictIntPipe) bangumiId: number, @Res() res: Response) {
    const success = db.bangumi.applyOffset(bangumiId);
    if (success) {
      await triggerRename();
      res.json({ status: true, msg_en: 'Offset applied.', msg_zh: '已应用偏移量。' });
    } else {
      res.status(404).json({
        status: false,
        msg_en: `Bangumi ${bangumiId} not found.`,
        msg_zh: `未找到番剧 ${bangumiId}。`,
      });
    }
  }

  @Get('/needs-review')
  getNeedsReview() {
    return db.bangumi.getNeedsReview();
  }

  /** Manually set the broadcast weekday for a bangumi (0-6 Mon-Sun, null resets). */
  @Patch('/:bangumi_id/weekday')
  setWeekday(
    @Param('bangumi_id', StrictIntPipe) bangumiId: number,
    @Body() request: { weekday?: number | null },
    @Res() res: Response,
  ) {
    const weekday = request.weekday ?? null;
    if (weekday !== null && !Number.isInteger(weekday)) {
      res.status(422).json({
        detail: [{ loc: ['body', 'weekday'], msg: 'Input should be a valid integer', type: 'int_parsing' }],
      });
      return;
    }
    if (weekday !== null && (weekday < 0 || weekday > 6)) {
      res.status(400).json({
        status: false,
        msg_en: 'Weekday must be 0-6 (Mon-Sun) or null.',
        msg_zh: '星期必须是 0-6（周一至周日）或空。',
      });
      return;
    }
    const success = db.bangumi.setWeekday(bangumiId, weekday);
    if (success) {
      const action = weekday !== null ? `weekday ${weekday}` : 'unknown';
      res.json({ status: true, msg_en: `Set bangumi to ${action}.`, msg_zh: `已设置放送日为 ${action}。` });
      return;
    }
    res.status(404).json({
      status: false,
      msg_en: `Bangumi ${bangumiId} not found.`,
      msg_zh: `未找到番剧 ${bangumiId}。`,
    });
  }

  // ------------------------------------------------------------------
  // Torrent management (#1020) — 孤儿种子：bangumi_id 为 NULL 的种子记录。
  // Literal paths are declared before /:bangumi_id/torrents to avoid capture.
  // ------------------------------------------------------------------

  @Get('/torrents/orphans')
  getOrphanTorrents() {
    return db.torrent.searchOrphans();
  }

  @Get('/torrents/orphans/count')
  getOrphanTorrentCount() {
    return db.torrent.countOrphans();
  }

  @Delete('/torrents/orphans')
  deleteOrphanTorrents(@Res() res: Response) {
    const count = db.torrent.deleteOrphans();
    uResponse(res, {
      status_code: 200,
      msg_en: `Deleted ${count} orphan torrents.`,
      msg_zh: `已删除 ${count} 条未匹配种子。`,
    });
  }

  @Delete('/torrents/orphans/:torrent_id')
  deleteOrphanTorrent(@Param('torrent_id', StrictIntPipe) torrentId: number, @Res() res: Response) {
    const torrent = db.torrent.search(torrentId);
    if (!torrent || torrent.bangumi_id !== null) {
      res.status(404).json({
        status: false,
        msg_en: `Orphan torrent ${torrentId} not found.`,
        msg_zh: `未找到孤儿种子 ${torrentId}。`,
      });
      return;
    }
    db.torrent.deleteObj(torrent);
    uResponse(res, {
      status_code: 200,
      msg_en: `Deleted torrent ${torrentId}.`,
      msg_zh: `已删除种子 ${torrentId}。`,
    });
  }

  @Get('/:bangumi_id/torrents')
  getBangumiTorrents(@Param('bangumi_id', StrictIntPipe) bangumiId: number) {
    return db.torrent.searchByBangumiId(bangumiId);
  }

  @Delete('/:bangumi_id/torrents')
  deleteBangumiTorrents(@Param('bangumi_id', StrictIntPipe) bangumiId: number, @Res() res: Response) {
    const count = db.torrent.deleteByBangumiId(bangumiId);
    uResponse(res, {
      status_code: 200,
      msg_en: `Deleted ${count} torrents for bangumi ${bangumiId}.`,
      msg_zh: `已删除番剧 ${bangumiId} 的 ${count} 条种子。`,
    });
  }

  @Delete('/:bangumi_id/torrents/:torrent_id')
  deleteBangumiTorrent(
    @Param('bangumi_id', StrictIntPipe) bangumiId: number,
    @Param('torrent_id', StrictIntPipe) torrentId: number,
    @Res() res: Response,
  ) {
    const torrent = db.torrent.search(torrentId);
    if (!torrent || torrent.bangumi_id !== bangumiId) {
      res.status(404).json({
        status: false,
        msg_en: `Torrent ${torrentId} not found under bangumi ${bangumiId}.`,
        msg_zh: `番剧 ${bangumiId} 下未找到种子 ${torrentId}。`,
      });
      return;
    }
    db.torrent.deleteObj(torrent);
    uResponse(res, {
      status_code: 200,
      msg_en: `Deleted torrent ${torrentId}.`,
      msg_zh: `已删除种子 ${torrentId}。`,
    });
  }
}
