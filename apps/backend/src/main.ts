/**
 * Entry point — mirrors main.py / __main__.
 *
 * Startup: rotate boot log -> init database (create tables + migrations) ->
 * create Nest app -> listen on settings.program.webui_port
 * (IPV6 env switches the bind address to '::').
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { settings } from './config/settings';
import { FileLogger, rotateBootLog } from './logger/file-logger';
import { serveStatic } from './static-hosting';

async function bootstrap(): Promise<void> {
  // CLI: -d/--debug（mirrors conf/parse.py）
  if (process.argv.includes('-d') || process.argv.includes('--debug')) {
    settings.data.log.debug_enable = true;
  }
  rotateBootLog();

  const logger = new FileLogger();
  logger.setDebug(settings.data.log.debug_enable);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });

  app.use(cookieParser());
  // Mirrors CORSMiddleware(allow_origins=[], allow_credentials=True):
  // no cross-origin ACAO headers are emitted; the WebUI is served same-origin.
  app.enableCors({ origin: false, credentials: true });

  serveStatic(app);

  const port = settings.data.program.webui_port;
  // Python __main__：IPV6 环境变量 → '::'；否则 HOST 环境变量（默认 0.0.0.0）
  const host = process.env.IPV6 ? '::' : (process.env.HOST ?? '0.0.0.0');

  // AppContext composition root (mirrors create_app/lifespan in main.py):
  // startup migrations run before serving; background tasks start only when
  // this is not a first-run boot.
  const { AppContext } = await import('./core/context');
  const { runtime } = await import('./core/runtime');
  const ctx = AppContext.build(settings);
  runtime.ctx = ctx;
  await ctx.startup();
  if (!ctx.firstRunBoot) {
    void ctx.startTasks();
  }

  await app.listen(port, host);
  logger.log(`AutoBangumi (Node) listening on ${host}:${port}`);

  // 优雅退出：SIGINT/SIGTERM 时停止周期任务并关闭 HTTP 服务（SQLite 的
  // 同步写已随每次 commit 落盘，WAL 无需额外处理）
  const shutdown = (signal: string) => {
    logger.log(`Received ${signal}, shutting down...`);
    void ctx
      .stop()
      .catch(() => undefined)
      .then(() => app.close())
      .finally(() => process.exit(0));
    // 兜底：5s 内未能完成清理也退出
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void bootstrap();
