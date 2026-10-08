/**
 * /api/v1/search — 1:1 port of module/api/search.py (SSE streaming search +
 * provider config).
 */
import {
  Body,
  Controller,
  Get,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { getProvider, saveProvider, SEARCH_CONFIG } from '../config/search-provider';
import { AuthGuard } from '../security/api';
import { SearchTorrent } from '../searcher/searcher';

@Controller('/api/v1/search')
@UseGuards(AuthGuard)
export class SearchController {
  /** SSE: per-bangumi-item stream for the search page. */
  @Get('/bangumi')
  async searchBangumi(
    @Query('site') site = 'mikan',
    @Query('keywords') keywords: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!keywords) {
      res.json([]);
      return;
    }
    const keywordList = keywords.split(' ');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    const st = new SearchTorrent();
    try {
      for await (const item of st.analyseKeyword(keywordList, site)) {
        if (closed) break;
        res.write(`data: ${item}\n\n`);
      }
    } catch {
      /* stream aborted mid-search */
    }
    if (!closed) res.end();
  }

  @Get('/provider')
  searchProviderList() {
    return Object.keys(SEARCH_CONFIG);
  }

  /** Get all search providers with their URL templates (URL only). */
  @Get('/provider/config')
  getSearchProviderConfig() {
    const providers = getProvider();
    return Object.fromEntries(Object.entries(providers).map(([site, cfg]) => [site, cfg.url]));
  }

  /** Update search providers configuration. */
  @Put('/provider/config')
  updateSearchProviderConfig(@Body() providers: Record<string, string>) {
    saveProvider(providers);
    const updated = getProvider();
    return Object.fromEntries(Object.entries(updated).map(([site, cfg]) => [site, cfg.url]));
  }
}
