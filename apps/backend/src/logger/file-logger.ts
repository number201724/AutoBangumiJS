/**
 * Logging — 1:1 port of module/conf/log.py.
 *
 * Format: "[YYYY-MM-DD HH:MM:SS,mmm] LEVEL:   message" (levelname padded to
 * 8, two spaces before message). Rotating file data/log.txt, 2MB x 3 backups;
 * the previous run's log is rotated aside at boot (rotate_boot_log).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LoggerService, LogLevel } from '@nestjs/common';

export const LOG_ROOT = 'data';
export const LOG_PATH = path.join(LOG_ROOT, 'log.txt');

const MAX_BYTES = 2 * 1024 * 1024;
const BACKUP_COUNT = 3;

type Level = 'debug' | 'info' | 'warning' | 'error' | 'critical';

const LEVEL_NAMES: Record<Level, string> = {
  debug: 'DEBUG:',
  info: 'INFO:',
  warning: 'WARNING:',
  error: 'ERROR:',
  critical: 'CRITICAL:',
};

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50,
};

function asctime(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`
  );
}

/** RotatingFileHandler.doRollover equivalent (rename chain log.txt -> .1 ...). */
function doRollover(): void {
  for (let i = BACKUP_COUNT; i >= 1; i--) {
    const src = i === 1 ? LOG_PATH : `${LOG_PATH}.${i - 1}`;
    const dst = `${LOG_PATH}.${i}`;
    try {
      if (i === BACKUP_COUNT && fs.existsSync(dst)) fs.unlinkSync(dst);
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    } catch {
      // best effort — rotation failure must not block startup
    }
  }
}

/** 启动时把上一次运行的日志轮转进备份，而非删除。 */
export function rotateBootLog(): void {
  try {
    if (!fs.existsSync(LOG_PATH) || fs.statSync(LOG_PATH).size === 0) return;
    doRollover();
  } catch (e) {
    process.stderr.write(`Boot log rotation failed: ${e}\n`);
  }
}

/**
 * NestJS LoggerService that tees to console and the rotating log file.
 */
export class FileLogger implements LoggerService {
  private minLevel: number = LEVEL_ORDER.info;
  private context?: string;

  constructor(context?: string) {
    this.context = context;
  }

  setDebug(debug: boolean): void {
    this.minLevel = debug ? LEVEL_ORDER.debug : LEVEL_ORDER.info;
  }

  private write(level: Level, message: unknown, context?: string): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const ctx = context ?? this.context;
    const text =
      message instanceof Error
        ? `${message.message}\n${message.stack}`
        : typeof message === 'string'
          ? message
          : JSON.stringify(message);
    const line = `[${asctime()}] ${LEVEL_NAMES[level].padEnd(8)}  ${ctx ? `[${ctx}] ` : ''}${text}`;

    // console
    const out = level === 'error' || level === 'critical' ? process.stderr : process.stdout;
    out.write(line + '\n');

    // file
    try {
      fs.mkdirSync(LOG_ROOT, { recursive: true });
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size + line.length > MAX_BYTES) {
        doRollover();
      }
      fs.appendFileSync(LOG_PATH, line + '\n', 'utf-8');
    } catch {
      // never crash on logging failure
    }
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }
  error(message: unknown, context?: string): void {
    this.write('error', message, context);
  }
  warn(message: unknown, context?: string): void {
    this.write('warning', message, context);
  }
  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
  fatal(message: unknown, context?: string): void {
    this.write('critical', message, context);
  }
  setLogLevels?(_levels: LogLevel[]): void {
    // levels are driven by settings.log.debug_enable, not Nest
  }
}
