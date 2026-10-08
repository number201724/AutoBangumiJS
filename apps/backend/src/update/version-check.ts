/**
 * Version check — 1:1 port of module/update/version_check.py.
 */
import * as fs from 'node:fs';
import { Logger } from '@nestjs/common';
import semver from 'semver';

import { VERSION, VERSION_PATH } from '../config/constants';

const logger = new Logger('VersionCheck');

/**
 * Check if version has changed.
 * Returns [isSameVersion, lastMinorVersion] — lastMinor is null when no
 * upgrade is needed.
 */
export function versionCheck(): [boolean, number | null] {
  if (VERSION === 'DEV_VERSION') return [true, null];
  if (VERSION === 'local') return [true, null];
  if (!fs.existsSync(VERSION_PATH)) {
    fs.writeFileSync(VERSION_PATH, VERSION + '\n');
    return [false, null];
  }
  const content = fs.readFileSync(VERSION_PATH, 'utf-8');
  const versions = content.split('\n').filter((l) => l.trim().length > 0);
  let lastVersion: string;
  try {
    lastVersion = versions[versions.length - 1].trim();
    if (!semver.valid(lastVersion)) throw new Error(`invalid: ${lastVersion}`);
  } catch (e) {
    logger.warn(
      `${VERSION_PATH} is empty or malformed (${e}); rewriting with the current version.`,
    );
    fs.writeFileSync(VERSION_PATH, VERSION + '\n');
    return [true, null];
  }
  const lastMinor = semver.minor(lastVersion);
  const nowMinor = semver.minor(VERSION);
  if (nowMinor === lastMinor) {
    return [true, null];
  }
  if (nowMinor > lastMinor) {
    fs.appendFileSync(VERSION_PATH, VERSION + '\n');
    return [false, lastMinor];
  }
  return [true, null];
}
