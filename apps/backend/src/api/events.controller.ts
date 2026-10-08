/**
 * GET /api/v1/events/stream — 1:1 port of module/api/events.py.
 *
 * One SSE connection pushing named events on their own cadences:
 * status 3s / downloader 5s / log 10s / notification 3s (revision-gated) /
 * update (only while an update is in progress).
 */
import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';

import { db } from '../database/facade';
import { getContext } from '../core/runtime';
import { LOG_PATH } from '../logger/file-logger';
import { inboxRevision } from '../notification/inbox';
import { AuthGuard } from '../security/api';
import { VERSION } from '../version';
import { lazyRequire } from '../utils/lazy';
import * as fs from 'node:fs';

import { Logger } from '@nestjs/common';

const logger = new Logger('EventsSSE');

const TICK_SECONDS = 1;
const STATUS_EVERY = 3;
const DOWNLOADER_EVERY = 5;
const LOG_EVERY = 10;
const NOTIFICATION_EVERY = 3;

// 下载器查询的超时上限（秒）。下载器不可达时认证重试可能阻塞 20-30s，
// 而 SSE 是单连接串行推送——不设上限会把 status/log 事件一起卡住。
const DOWNLOADER_TIMEOUT_SECONDS = 3.0;

// 复用 api/log 的尾部读取逻辑（含轮转 .1 拼接，与 log.controller 同一实现）
import { readLogTail } from './log.controller';

function readLogTailText(): string | null {
  if (!fs.existsSync(LOG_PATH)) return null;
  return readLogTail().toString('utf-8');
}

interface DownloaderModuleLike {
  DownloadClient: new () => {
    withClient<T>(fn: (client: {
      getTorrentInfo(category?: string, statusFilter?: string | null): Promise<unknown[]>;
    }) => Promise<T>): Promise<T>;
  };
}

/** 获取种子列表；下载器未配置、不可达或超时时返回 null（显式降级信号）。 */
async function downloaderPayload(): Promise<unknown[] | null> {
  try {
    const { DownloadClient } = lazyRequire<DownloaderModuleLike>('../downloader/download-client');
    const fetch = () =>
      new DownloadClient().withClient((client) =>
        client.getTorrentInfo('Bangumi', null),
      );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DOWNLOADER_TIMEOUT_SECONDS * 1000);
    });
    const result = await Promise.race([fetch(), timeout]);
    clearTimeout(timer);
    return result;
  } catch (e) {
    logger.debug(`SSE: downloader status unavailable: ${e}`);
    return null;
  }
}

interface UpdateProgressLike {
  phase: string;
  [key: string]: unknown;
}

function getUpdateProgress(): UpdateProgressLike {
  try {
    return lazyRequire<{ getUpdateProgress(): UpdateProgressLike }>(
      '../update/updater',
    ).getUpdateProgress();
  } catch {
    return { phase: 'idle' };
  }
}

function writeEvent(res: Response, event: string, data: string): boolean {
  // SSE 分帧：多行 data 必须逐行写 data: 前缀（sse_starlette 语义）——
  // 日志帧天然多行，直接内嵌 \n 会把帧写坏且注入伪字段
  const lines = data.split('\n').map((l) => `data: ${l}`).join('\n');
  return res.write(`event: ${event}\n${lines}\n\n`);
}

@Controller('/api/v1/events')
export class EventsController {
  @Get('/stream')
  @UseGuards(AuthGuard)
  async stream(@Req() req: Request, @Res() res: Response): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const ctx = getContext();
    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    const statusPayload = () =>
      JSON.stringify({ status: ctx.isRunning, version: VERSION, first_run: ctx.firstRun });

    let tick = 0;
    let lastUpdate: string | null = null;
    let lastInboxRev: number | null = null;
    let lastPing = Date.now();

    while (!closed && !res.writableEnded) {
      // sse_starlette 默认 15s 注释保活帧（防代理空闲断连）
      if (Date.now() - lastPing >= 15_000) {
        res.write(': ping\n\n');
        lastPing = Date.now();
      }
      // 更新进度：仅在有进行中的更新且负载变化时推送
      const progress = getUpdateProgress();
      if (progress.phase !== 'idle') {
        const payload = JSON.stringify(progress);
        if (payload !== lastUpdate) {
          lastUpdate = payload;
          writeEvent(res, 'update', payload);
        }
      }

      if (tick % STATUS_EVERY === 0) {
        writeEvent(res, 'status', statusPayload());
      }

      if (tick % DOWNLOADER_EVERY === 0) {
        // 不可用时推送 null 而非跳过，前端据此感知下载器降级状态
        const torrents = await downloaderPayload();
        writeEvent(res, 'downloader', JSON.stringify(torrents));
      }

      if (tick % LOG_EVERY === 0) {
        const logText = readLogTailText();
        if (logText !== null) {
          writeEvent(res, 'log', logText);
        }
      }

      // 通知中心：只在修订号变化时查库推送
      if (tick % NOTIFICATION_EVERY === 0) {
        const rev = inboxRevision();
        if (rev !== lastInboxRev) {
          try {
            const payload = {
              unread_count: db.inbox.unreadCount(),
              latest_id: db.inbox.latestId(),
              revision: rev,
            };
            lastInboxRev = rev;
            writeEvent(res, 'notification', JSON.stringify(payload));
          } catch (e) {
            logger.debug(`SSE: notification payload unavailable: ${e}`);
          }
        }
      }

      await new Promise((r) => setTimeout(r, TICK_SECONDS * 1000));
      tick += TICK_SECONDS;
    }

    res.end();
  }
}
