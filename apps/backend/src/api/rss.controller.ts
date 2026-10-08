/**
 * /api/v1/rss — 1:1 port of module/api/rss.py.
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
  Res,
  UseGuards,
} from '@nestjs/common';
import { StrictIntPipe } from './pipes';
import type { Response } from 'express';

import { getProvider } from '../config/search-provider';
import { db } from '../database/facade';
import type { NewBangumiRow, RssRow } from '../database/schema';
import { DownloadClient } from '../downloader/download-client';
import { SeasonCollector } from '../manager';
import { RSSAnalyser } from '../rss/analyser';
import { RSSEngine } from '../rss/engine';
import { AuthGuard } from '../security/api';
import { uResponse } from './response';
import type { RssUpdateData } from '../database/repos/rss';

// RSSItem.parser 的合法取值（与 webui ab-add-rss 的选项一致）；这些值即便与
// 搜索站点同名（mikan）也不做站点名映射
const PARSER_TYPES = new Set(['mikan', 'tmdb', 'parser', 'ani']);

const analyser = new RSSAnalyser();

@Controller('/api/v1/rss')
@UseGuards(AuthGuard)
export class RssController {
  @Get('')
  getRss() {
    return db.rss.searchAll();
  }

  @Post('/add')
  @HttpCode(200)
  async addRss(@Body() rss: Partial<RssRow>, @Res() res: Response) {
    const engine = new RSSEngine(db);
    const result = await engine.addRss(
      // RSSItem.url 模型默认 https://mikanani.me
      rss.url ?? 'https://mikanani.me',
      rss.name ?? null,
      // RSSItem.aggregate 模型默认 False（独立订阅）——对齐 pydantic 模型默认
      rss.aggregate ?? false,
      rss.parser ?? 'mikan',
    );
    uResponse(res, result);
  }

  @Post('/enable/many')
  @HttpCode(200)
  async enableManyRss(@Body() rssIds: number[], @Res() res: Response) {
    const engine = new RSSEngine(db);
    uResponse(res, await engine.enableList(rssIds));
  }

  @Delete('/delete/:rss_id')
  deleteRss(@Param('rss_id', StrictIntPipe) rssId: number, @Res() res: Response) {
    if (db.rss.delete(rssId)) {
      res.json({ msg_en: 'Delete RSS successfully.', msg_zh: '删除 RSS 成功。' });
    } else {
      res.status(400).json({ msg_en: 'Delete RSS failed.', msg_zh: '删除 RSS 失败。' });
    }
  }

  @Post('/delete/many')
  @HttpCode(200)
  async deleteManyRss(@Body() rssIds: number[], @Res() res: Response) {
    const engine = new RSSEngine(db);
    uResponse(res, await engine.deleteList(rssIds));
  }

  @Patch('/disable/:rss_id')
  disableRss(@Param('rss_id', StrictIntPipe) rssId: number, @Res() res: Response) {
    if (db.rss.disable(rssId)) {
      res.json({ msg_en: 'Disable RSS successfully.', msg_zh: '禁用 RSS 成功。' });
    } else {
      res.status(404).json({ msg_en: 'Disable RSS failed.', msg_zh: '禁用 RSS 失败。' });
    }
  }

  @Post('/disable/many')
  @HttpCode(200)
  async disableManyRss(@Body() rssIds: number[], @Res() res: Response) {
    const engine = new RSSEngine(db);
    uResponse(res, await engine.disableList(rssIds));
  }

  @Patch('/update/:rss_id')
  updateRss(
    @Param('rss_id', StrictIntPipe) rssId: number,
    @Body() data: RssUpdateData,
    @Res() res: Response,
  ) {
    if (db.rss.update(rssId, data)) {
      res.json({ msg_en: 'Update RSS successfully.', msg_zh: '更新 RSS 成功。' });
    } else {
      res.status(404).json({ msg_en: 'Update RSS failed.', msg_zh: '更新 RSS 失败。' });
    }
  }

  @Post('/refresh/all')
  @HttpCode(200)
  async refreshAll(@Res() res: Response) {
    await new DownloadClient().withClient(async (client) => {
      const engine = new RSSEngine(db);
      await engine.refreshRss(client);
    });
    res.json({ msg_en: 'Refresh all RSS successfully.', msg_zh: '刷新 RSS 成功。' });
  }

  @Post('/refresh/:rss_id')
  @HttpCode(200)
  async refreshRss(@Param('rss_id', StrictIntPipe) rssId: number, @Res() res: Response) {
    await new DownloadClient().withClient(async (client) => {
      const engine = new RSSEngine(db);
      await engine.refreshRss(client, rssId);
    });
    res.json({ msg_en: 'Refresh RSS successfully.', msg_zh: '刷新 RSS 成功。' });
  }

  @Get('/torrent/:rss_id')
  async getTorrent(@Param('rss_id', StrictIntPipe) rssId: number) {
    const engine = new RSSEngine(db);
    return engine.getRssTorrents(rssId);
  }

  /** Single-link analysis preview (subscribe dialog). */
  @Post('/analysis')
  @HttpCode(200)
  async analysis(@Body() rss: RssRow, @Res() res: Response) {
    const data = await analyser.linkToData(rss);
    if (typeof data === 'object' && data !== null && 'official_title' in data) {
      res.json(data);
      return;
    }
    uResponse(res, data as { status_code: number; msg_en: string; msg_zh: string });
  }

  @Post('/collect')
  @HttpCode(200)
  async downloadCollection(@Body() data: NewBangumiRow & { id?: number }, @Res() res: Response) {
    await new DownloadClient().withClient(async (client) => {
      const collector = new SeasonCollector(client);
      const resp = await collector.collectSeason(data, data.rss_link ?? null);
      uResponse(res, resp);
    });
  }

  @Post('/subscribe')
  @HttpCode(200)
  async subscribe(
    @Body() body: { data?: NewBangumiRow; rss?: RssRow } & Partial<NewBangumiRow>,
    @Res() res: Response,
  ) {
    // FastAPI 签名是 (data: Bangumi, rss: RSSItem)——前端把两者打平在一个
    // body 里；兼容两种形态。
    const data = (body.data ?? body) as NewBangumiRow & { id?: number };
    const rss = (body.rss ?? body) as RssRow;
    // 搜索订阅时前端传来的是站点名（nyaa/dmhy），而分析器只认识解析器类型
    // mikan/tmdb——按搜索源配置把站点名映射为解析器；已是解析器类型的值原样
    // 透传（#1053）
    let parser = rss.parser;
    if (!PARSER_TYPES.has(parser)) {
      const providers = getProvider();
      if (parser in providers) {
        parser = providers[parser].parser;
      }
    }
    const resp = await SeasonCollector.subscribeSeason(data, parser);
    uResponse(res, resp);
  }
}
