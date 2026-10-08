/**
 * GET /health — unauthenticated probe (mirrors main.py's health endpoint).
 */
import { Controller, Get } from '@nestjs/common';

import { VERSION } from './version';
import { checkDatabase } from './database/database';

@Controller()
export class HealthController {
  @Get('/health')
  health() {
    return {
      status: 'ok',
      version: VERSION,
      db_ok: checkDatabase(),
    };
  }
}
