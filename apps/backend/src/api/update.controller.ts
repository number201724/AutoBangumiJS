/**
 * /api/v1/update — online update endpoints.
 *
 * The signed online-updater (download/apply/rollback + boot overlay) is a
 * phase-2 module in the Node.js rewrite; these endpoints keep the API
 * contract and report the feature as unavailable instead of 404ing.
 */
import { Controller, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { settings } from '../config/settings';
import { AuthGuard } from '../security/api';
import { VERSION } from '../version';
import { checkUpdate } from '../update/updater';
import { parseBoolQuery } from './pipes';

@Controller('/api/v1/update')
@UseGuards(AuthGuard)
export class UpdateController {
  /** 查询最新版本（updater 未就绪时返回 has_update=false + error）。 */
  @Get('/check')
  async check(@Query('channel') channel?: string, @Query('force') force?: string) {
    const ch = channel || settings.data.update.channel;
    const result = await checkUpdate(ch, parseBoolQuery(force));
    return {
      ...result,
      current: VERSION,
      overlay: null,
    };
  }

  @Post('/apply')
  @HttpCode(400)
  apply(@Res() res: Response) {
    res.json({
      success: false,
      message: 'Online update is not available in the Node.js build (phase 2).',
      message_zh: '当前构建暂不支持在线更新（二期）。',
      version: null,
      restart_required: false,
    });
  }

  @Post('/rollback')
  @HttpCode(400)
  rollback(@Res() res: Response) {
    res.json({
      success: false,
      message: 'Online update is not available in the Node.js build (phase 2).',
      message_zh: '当前构建暂不支持在线更新（二期）。',
      version: null,
      restart_required: false,
    });
  }
}
