/**
 * Poster cache — 1:1 port of module/utils/cache_image.py.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { Logger } from '@nestjs/common';

const logger = new Logger('CacheImage');

/**
 * 保存图片到本地缓存。传入 source_url 时在图片旁写一个 `<name>.url`
 * sidecar 记录源地址（通知端可以直接发 URL 让服务端拉图，#1094）。
 */
export async function saveImage(
  img: Buffer | null,
  suffix: string,
  sourceUrl?: string | null,
): Promise<string | null> {
  if (img === null) {
    return null;
  }
  const imgHash = crypto.createHash('md5').update(img).digest('hex').slice(0, 8);
  const imagePath = `data/posters/${imgHash}.${suffix}`;
  await fs.mkdir('data/posters', { recursive: true });
  await fs.writeFile(imagePath, img);
  if (sourceUrl) {
    await fs.writeFile(`${imagePath}.url`, sourceUrl, 'utf-8');
  }
  return `posters/${imgHash}.${suffix}`;
}

/** 读取缓存图片；缓存文件丢失返回 null，不炸穿通知发送。 */
export async function loadImage(imgPath: string | null | undefined): Promise<Buffer | null> {
  if (!imgPath) return null;
  try {
    return await fs.readFile(`data/${imgPath}`);
  } catch {
    logger.warn(`Cached poster ${imgPath} is missing or unreadable.`);
    return null;
  }
}

/** 读取缓存图片对应的源 URL sidecar；旧缓存没有 sidecar 时返回 null。 */
export async function loadPosterUrl(imgPath: string | null | undefined): Promise<string | null> {
  if (!imgPath) return null;
  try {
    const content = await fs.readFile(`data/${imgPath}.url`, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}
