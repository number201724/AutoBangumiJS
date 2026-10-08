/**
 * /api/v1 program control — 1:1 port of module/api/program.py.
 */
import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { getContext } from '../core/runtime';
import { AuthGuard } from '../security/api';
import { VERSION } from '../version';
import { uResponse } from './response';

import { Logger } from '@nestjs/common';

const logger = new Logger('ProgramAPI');

@Controller('/api/v1')
@UseGuards(AuthGuard)
export class ProgramController {
  private async handleRestart(res: Response) {
    try {
      const resp = await getContext().restart();
      uResponse(res, resp);
    } catch (e) {
      logger.debug(String(e));
      logger.warn('Failed to restart program');
      throw new HttpException({ msg_en: 'Failed to restart program.', msg_zh: '重启程序失败。' }, 500);
    }
  }

  private async handleStart(res: Response) {
    try {
      const resp = await getContext().startTasks();
      uResponse(res, resp);
    } catch (e) {
      logger.debug(String(e));
      logger.warn('Failed to start program');
      throw new HttpException({ msg_en: 'Failed to start program.', msg_zh: '启动程序失败。' }, 500);
    }
  }

  private async handleStop(res: Response) {
    const resp = await getContext().stop();
    uResponse(res, resp);
  }

  private async handleShutdown(res: Response) {
    await getContext().stop();
    logger.log('Shutting down program...');
    res.json({ msg_en: 'Shutdown program successfully.', msg_zh: '关闭程序成功。' });
    // SIGINT equivalent: graceful process exit after the response is sent
    setImmediate(() => process.kill(process.pid, 'SIGINT'));
  }

  @Post('/restart')
  @HttpCode(200)
  restart(@Res() res: Response) {
    return this.handleRestart(res);
  }

  @Post('/start')
  @HttpCode(200)
  start(@Res() res: Response) {
    return this.handleStart(res);
  }

  @Post('/stop')
  @HttpCode(200)
  stop(@Res() res: Response) {
    return this.handleStop(res);
  }

  @Post('/shutdown')
  @HttpCode(200)
  shutdown(@Res() res: Response) {
    return this.handleShutdown(res);
  }

  // 3.2 兼容：这些控制端点在 3.2 及更早版本是 GET，外部自动化沿用旧方法，
  // 升级后不得 405 静默失效。GET 别名已 deprecated，计划下个大版本移除。
  @Get('/restart')
  restartLegacy(@Res() res: Response) {
    return this.handleRestart(res);
  }

  @Get('/start')
  startLegacy(@Res() res: Response) {
    return this.handleStart(res);
  }

  @Get('/stop')
  stopLegacy(@Res() res: Response) {
    return this.handleStop(res);
  }

  @Get('/shutdown')
  shutdownLegacy(@Res() res: Response) {
    return this.handleShutdown(res);
  }

  @Get('/status')
  programStatus() {
    const ctx = getContext();
    return { status: ctx.isRunning, version: VERSION, first_run: ctx.firstRun };
  }

  @Get('/check/downloader')
  async checkDownloaderStatus() {
    return getContext().checkDownloader();
  }
}
