/**
 * /api/v1/log — 1:1 port of module/api/log.py.
 */
import * as fs from 'node:fs';
import { Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { LOG_PATH } from '../logger/file-logger';
import { AuthGuard } from '../security/api';

const TAIL_BYTES = 512 * 1024; // 512 KB

/** 同步读取单个文件的最后 budget 字节（掐掉开头的半行）。 */
function readFileTail(path: string, budget: number): { data: Buffer; truncated: boolean } {
  try {
    const fd = fs.openSync(path, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > budget) {
        const data = Buffer.alloc(budget);
        fs.readSync(fd, data, 0, budget, size - budget);
        // Drop first partial line
        const idx = data.indexOf(0x0a); // '\n'
        return { data: idx !== -1 ? data.subarray(idx + 1) : data, truncated: true };
      }
      const data = Buffer.alloc(size);
      fs.readSync(fd, data, 0, size, 0);
      return { data, truncated: false };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { data: Buffer.alloc(0), truncated: false };
  }
}

/**
 * 轮转刚发生后 log.txt 近乎为空；仅当 log.txt 完整读入（未截断）且预算有剩
 * 时，把 log.txt.1 的尾部拼在前面。截断读取时绝不拼接。
 */
export function readLogTail(): Buffer {
  const { data, truncated } = readFileTail(LOG_PATH, TAIL_BYTES);
  if (truncated) return data;
  const remaining = TAIL_BYTES - data.length;
  if (remaining > 0) {
    const backup = readFileTail(`${LOG_PATH}.1`, remaining);
    return Buffer.concat([backup.data, data]);
  }
  return data;
}

@Controller('/api/v1/log')
@UseGuards(AuthGuard)
export class LogController {
  @Get('')
  getLog(@Res() res: Response): void {
    if (fs.existsSync(LOG_PATH)) {
      const data = readLogTail();
      res.type('text/plain').send(data);
    } else {
      res.status(404).type('text/plain').send('Log file not found');
    }
  }

  @Post('/clear')
  @HttpCode(200)
  clearLog(@Res() res: Response): void {
    if (fs.existsSync(LOG_PATH)) {
      // 清空日志并删除轮转备份，否则拼接读取会把旧内容带回来
      fs.writeFileSync(LOG_PATH, '');
      for (const name of fs.readdirSync('data')) {
        if (name.startsWith('log.txt.')) {
          try {
            fs.unlinkSync(`data/${name}`);
          } catch {
            // best effort
          }
        }
      }
      res.json({ msg_en: 'Log cleared successfully.', msg_zh: '日志清除成功。' });
    } else {
      res.status(404).json({ msg_en: 'Log file not found.', msg_zh: '日志文件未找到。' });
    }
  }
}
