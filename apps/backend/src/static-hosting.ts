/**
 * Static hosting — mirrors main.py: /posters/{path} (traversal-guarded) plus
 * the built WebUI (dist/) with SPA fallback outside DEV builds.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';

import { POSTERS_PATH } from './config/constants';
import { VERSION } from './version';

/** Resolve the webui dist directory (monorepo dev vs container vs assembled). */
function resolveDistDir(): string | null {
  const candidates = [
    process.env.AB_STATIC_DIR ?? '',
    // 组装的单 dist 布局：main.js 与 webui/ 同级（node dist/main.js）
    path.resolve(__dirname, 'webui'),
    path.resolve('dist'),
    path.resolve(__dirname, '../../webui/dist'),
    path.resolve(__dirname, '../../../webui/dist'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}

/** GET /posters/* — cached poster files, with path-traversal protection. */
function posterHandler(req: Request, res: Response): void {
  // req.path = /posters/<file>（app.use('/posters', ...) 已剥离前缀）
  const rel = decodeURIComponent(req.path.replace(/^\/+/, ''));
  const segments = rel.split('/').filter(Boolean);
  if (
    !segments.length ||
    segments.some(
      (s) => s === '.' || s === '..' || s.includes('..') || s.includes('\\'),
    )
  ) {
    res.status(400).json({ detail: 'Invalid path' });
    return;
  }
  const filePath = path.resolve(POSTERS_PATH, ...segments);
  if (!filePath.startsWith(path.resolve(POSTERS_PATH) + path.sep)) {
    res.status(400).json({ detail: 'Invalid path' });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.status(404).json({ detail: 'Not found' });
    return;
  }
  res.sendFile(filePath);
}

export function serveStatic(app: NestExpressApplication): void {
  // /posters/{path}
  app.use('/posters', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();
    posterHandler(req, res);
  });

  if (VERSION === 'DEV_VERSION') {
    return; // dev: frontend served by Vite on :5173
  }

  const distDir = resolveDistDir();
  if (!distDir) return;

  for (const sub of ['assets', 'images', 'fonts']) {
    const dir = path.join(distDir, sub);
    if (fs.existsSync(dir)) {
      app.use(`/${sub}`, express.static(dir, { maxAge: '7d' }));
    }
  }

  // SPA fallback: every non-API GET renders index.html
  const indexHtml = path.join(distDir, 'index.html');
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/health') ||
      req.path.startsWith('/posters') ||
      req.path.startsWith('/mcp')
    ) {
      return next();
    }
    res.sendFile(indexHtml);
  });
}
