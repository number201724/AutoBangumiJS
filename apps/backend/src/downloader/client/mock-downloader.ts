/**
 * Mock Downloader for local development and testing — 1:1 port of
 * module/downloader/client/mock_downloader.py.
 *
 * This downloader simulates qBittorrent behavior without requiring an actual
 * qBittorrent instance. All operations return success and log their actions.
 */
import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import {
  AddResult,
  type DownloaderCapabilities,
  type DownloaderClient,
  RenameOutcome,
  RenameResult,
} from '../base';

const logger = new Logger('MockDownloader');

/** mock 种子记录：tags 可能是 string 或 string[]（与 Python 端一致，见 addTag）。 */
type MockTorrent = Record<string, any>;

/**
 * A mock downloader that simulates qBittorrent API responses.
 * All methods return success values and log their operations.
 */
export class MockDownloader implements DownloaderClient {
  readonly capabilities: DownloaderCapabilities = {
    can_query: true,
    can_rename: true,
    can_manage: true,
    can_rss_rules: true,
  };

  private torrents: Record<string, MockTorrent> = {};
  private rules: Record<string, Record<string, unknown>> = {};
  private feeds: Record<string, Record<string, unknown>> = {};
  private categories = new Set(['Bangumi', 'BangumiCollection']);
  private authed = false;
  private prefs: Record<string, unknown> = {
    save_path: '/tmp/mock-downloads',
    rss_auto_downloading_enabled: true,
    rss_max_articles_per_feed: 500,
    rss_processing_enabled: true,
    rss_refresh_interval: 30,
  };

  constructor() {
    logger.debug('Initialized');
  }

  async auth(_retry = 3): Promise<boolean> {
    // No real session; idempotent by construction, kept for parity with
    // QbDownloader so session-reuse tests stay meaningful.
    this.authed = true;
    logger.debug('Auth successful (mocked)');
    return true;
  }

  async logout(): Promise<void> {
    this.authed = false;
    logger.debug('Logout (mocked)');
  }

  async checkHost(): Promise<boolean> {
    logger.debug('check_host -> True');
    return true;
  }

  async prefsInit(prefs: Record<string, unknown>): Promise<void> {
    Object.assign(this.prefs, prefs);
    logger.debug(`prefs_init: ${JSON.stringify(prefs)}`);
  }

  async getAppPrefs(): Promise<Record<string, unknown>> {
    logger.debug('get_app_prefs');
    return this.prefs;
  }

  async addCategory(category: string): Promise<void> {
    this.categories.add(category);
    logger.debug(`add_category: ${category}`);
  }

  /** Return list of torrents matching the filter. */
  async torrentsInfo(
    statusFilter: string | null,
    category: string | null,
    tag: string | null = null,
  ): Promise<Array<Record<string, unknown>>> {
    logger.debug(`torrents_info(filter=${statusFilter}, category=${category}, tag=${tag})`);
    const result: MockTorrent[] = [];
    for (const torrent of Object.values(this.torrents)) {
      if (category && torrent['category'] !== category) {
        continue;
      }
      const tags = (torrent['tags'] ?? []) as string | string[];
      // Python `tag in tags`：对 str 是子串判断，对 list 是成员判断；
      // JS 的 String/Array .includes 恰好各自对应。
      if (tag && !tags.includes(tag as never)) {
        continue;
      }
      result.push(torrent);
    }
    return result;
  }

  /** Return all torrents carrying a given tag. */
  async getTorrentsByTag(tag: string): Promise<Array<Record<string, unknown>>> {
    logger.debug(`get_torrents_by_tag(${tag})`);
    return Object.values(this.torrents).filter((t) =>
      ((t['tags'] ?? []) as string | string[]).includes(tag as never),
    );
  }

  async torrentExists(torrentHash: string): Promise<boolean | null> {
    return torrentHash in this.torrents;
  }

  /** Return files for a torrent. */
  async torrentsFiles(torrentHash: string): Promise<Array<Record<string, unknown>>> {
    logger.debug(`torrents_files(${torrentHash})`);
    const torrent = this.torrents[torrentHash] ?? {};
    return (torrent['files'] ?? []) as Array<Record<string, unknown>>;
  }

  /** Add a torrent. Returns ADDED for success. */
  async addTorrents(
    torrentUrls: string | string[] | null,
    torrentFiles: Buffer | Buffer[] | null,
    savePath: string,
    category: string,
    tags: string | null = null,
  ): Promise<AddResult> {
    // Generate a mock hash
    const content = String(torrentUrls || torrentFiles || Date.now());
    const mockHash = createHash('sha1').update(content, 'utf-8').digest('hex');

    this.torrents[mockHash] = {
      hash: mockHash,
      name: `mock_torrent_${mockHash.slice(0, 8)}`,
      save_path: savePath,
      category,
      state: 'downloading',
      progress: 0.0,
      files: [],
      tags: tags || '',
    };
    logger.log(`add_torrents -> hash=${mockHash.slice(0, 16)}... save_path=${savePath}`);
    return AddResult.ADDED;
  }

  /**
   * Accept a single hash, a pipe-joined string, or a list/tuple of
   * hashes and always return a list -- mirrors the real qB client's
   * normalization so switching downloader backends doesn't change
   * behavior (#1046).
   */
  private static normalizeHashes(hashes: string | string[]): string[] {
    if (Array.isArray(hashes)) {
      return [...hashes];
    }
    return hashes.includes('|') ? hashes.split('|') : [hashes];
  }

  async torrentsDelete(hash: string | string[], deleteFiles = true): Promise<boolean> {
    for (const h of MockDownloader.normalizeHashes(hash)) {
      delete this.torrents[h];
    }
    logger.debug(`torrents_delete(${hash}, delete_files=${deleteFiles})`);
    return true;
  }

  async torrentsPause(hashes: string | string[]): Promise<void> {
    for (const h of MockDownloader.normalizeHashes(hashes)) {
      if (h in this.torrents) {
        this.torrents[h]['state'] = 'paused';
      }
    }
    logger.debug(`torrents_pause(${hashes})`);
  }

  async torrentsResume(hashes: string | string[]): Promise<void> {
    for (const h of MockDownloader.normalizeHashes(hashes)) {
      if (h in this.torrents) {
        this.torrents[h]['state'] = 'downloading';
      }
    }
    logger.debug(`torrents_resume(${hashes})`);
  }

  async torrentsRenameFile(
    torrentHash: string,
    oldPath: string,
    newPath: string,
    verify = true,
  ): Promise<RenameResult> {
    void torrentHash;
    void verify;
    logger.log(`rename: ${oldPath} -> ${newPath}`);
    return new RenameResult(RenameOutcome.RENAMED);
  }

  async rssAddFeed(url: string, itemPath: string): Promise<void> {
    this.feeds[itemPath] = { url, path: itemPath };
    logger.debug(`rss_add_feed(${url}, ${itemPath})`);
  }

  async rssRemoveItem(itemPath: string): Promise<void> {
    delete this.feeds[itemPath];
    logger.debug(`rss_remove_item(${itemPath})`);
  }

  async rssGetFeeds(): Promise<Record<string, unknown>> {
    logger.debug('rss_get_feeds');
    return this.feeds;
  }

  async rssSetRule(ruleName: string, ruleDef: Record<string, unknown>): Promise<void> {
    this.rules[ruleName] = ruleDef;
    logger.log(`rss_set_rule(${ruleName})`);
  }

  async moveTorrent(hashes: string | string[], newLocation: string): Promise<void> {
    for (const h of MockDownloader.normalizeHashes(hashes)) {
      if (h in this.torrents) {
        this.torrents[h]['save_path'] = newLocation;
      }
    }
    logger.debug(`move_torrent(${hashes}, ${newLocation})`);
  }

  async getDownloadRule(): Promise<Record<string, unknown>> {
    logger.debug('get_download_rule');
    return this.rules;
  }

  async getTorrentPath(hash: string): Promise<string> {
    const torrent = this.torrents[hash] ?? {};
    const p = (torrent['save_path'] as string) ?? '/tmp/mock-downloads';
    logger.debug(`get_torrent_path(${hash}) -> ${p}`);
    return p;
  }

  async setCategory(hash: string | string[], category: string): Promise<void> {
    for (const h of MockDownloader.normalizeHashes(hash)) {
      if (h in this.torrents) {
        this.torrents[h]['category'] = category;
      }
    }
    logger.debug(`set_category(${hash}, ${category})`);
  }

  async removeRule(ruleName: string): Promise<void> {
    delete this.rules[ruleName];
    logger.debug(`remove_rule(${ruleName})`);
  }

  async addTag(hash: string, tag: string): Promise<void> {
    const torrent = this.torrents[hash];
    if (torrent) {
      torrent['tags'] ??= [];
      const tags = torrent['tags'] as string | string[];
      // Python 端 tags 为 str 时 setdefault + .append 会 AttributeError
      // （潜在 bug）；mock 按标签集合的意图处理，两种形态都不重复添加。
      if (Array.isArray(tags)) {
        if (!tags.includes(tag)) {
          tags.push(tag);
        }
      } else if (!tags.includes(tag)) {
        torrent['tags'] = `${tags},${tag}`;
      }
    }
    logger.debug(`add_tag(${hash}, ${tag})`);
  }

  async checkConnection(): Promise<string> {
    return 'v4.6.0 (mock)';
  }

  // Helper methods for testing

  /** Add a mock torrent for testing purposes. */
  addMockTorrent(
    name: string,
    hash: string | null = null,
    category = 'Bangumi',
    state = 'completed',
    savePath = '/tmp/mock-downloads',
    files: Array<Record<string, unknown>> | null = null,
  ): string {
    const h = hash ?? createHash('sha1').update(name, 'utf-8').digest('hex');
    this.torrents[h] = {
      hash: h,
      name,
      save_path: savePath,
      category,
      state,
      progress: state === 'completed' ? 1.0 : 0.5,
      files: files ?? [{ name: `${name}.mkv`, size: 1024 * 1024 * 500 }],
      tags: [],
    };
    logger.debug(`Added mock torrent: ${name}`);
    return h;
  }

  /** Get the current mock state for debugging. */
  getState(): Record<string, unknown> {
    return {
      torrents: this.torrents,
      rules: this.rules,
      feeds: this.feeds,
      categories: [...this.categories],
    };
  }
}
