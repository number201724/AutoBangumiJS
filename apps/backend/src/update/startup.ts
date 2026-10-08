/**
 * Startup helpers — 1:1 port of module/update/startup.py + auth.py.
 */
import * as fs from 'node:fs';
import { Logger } from '@nestjs/common';

import { POSTERS_PATH } from '../config/constants';
import { settings } from '../config/settings';
import { initDatabase } from '../database/database';
import { db } from '../database/facade';

const logger = new Logger('Startup');

export async function startUp(): Promise<void> {
  initDatabase();
  await db.user.addDefaultUser();
}

export async function firstRun(): Promise<void> {
  initDatabase();
  await db.user.addDefaultUser();
  fs.mkdirSync(POSTERS_PATH, { recursive: true });
}

/**
 * One-way migration of legacy plaintext bearer tokens into the database.
 */
export function migrateLegacyAuthTokens(): number {
  const loginTokens = [...settings.data.security.login_tokens];
  const mcpTokens = [...settings.data.security.mcp_tokens];
  if (!loginTokens.length && !mcpTokens.length) return 0;

  const users = db.user.listUsers().filter((u) => u.enabled);
  if (!users.length) {
    logger.warn('[Auth] Legacy tokens remain in config: no enabled user');
    return 0;
  }
  const owner = users[0];
  loginTokens.forEach((rawToken, i) => {
    db.auth.importApiToken(owner.id, rawToken, `Imported API token ${i + 1}`, 'api');
  });
  mcpTokens.forEach((rawToken, i) => {
    db.auth.importApiToken(owner.id, rawToken, `Imported MCP token ${i + 1}`, 'mcp');
  });

  settings.data.security.login_tokens = [];
  settings.data.security.mcp_tokens = [];
  settings.save();
  const imported = loginTokens.length + mcpTokens.length;
  logger.log(`[Auth] Imported ${imported} legacy bearer tokens`);
  return imported;
}
