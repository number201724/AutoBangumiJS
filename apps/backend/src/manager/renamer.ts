/**
 * Renamer — 1:1 port of module/manager/renamer.py (#1078 durable rename saga).
 *
 * The persisted rename_operation state machine makes every external mutation
 * idempotent and crash-recoverable; downloader calls deliberately happen
 * outside database transactions.
 */
import * as crypto from 'node:crypto';
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { db } from '../database/facade';
import {
  buildSavePathIndex,
  matchBangumiInList,
  normalizeSavePath,
} from '../database/repos/bangumi';
import type { NewRenameOperationRow, RenameOperationRow } from '../database/schema';
import { AddResult } from '../downloader/base';
import { RenameOutcome, RenameResult } from '../downloader/base';
import type { DownloadClient } from '../downloader/download-client';
import { checkFiles, isEp, pathToBangumi } from '../downloader/path';
import { lazyRequire } from '../utils/lazy';
import { utcInSeconds, utcNow } from '../utils/time';
import type { MediaType } from '../parser/types';
import {
  isStrictUpgrade,
  parseRevisionIdentity,
  replacementStagedPath,
  type RevisionIdentity,
} from './revision-policy';
import { expandEnv } from '../utils/env';

const logger = new Logger('Renamer');

const PENDING_RENAME_COOLDOWN = 300; // 5 minutes cooldown before retrying same rename

// 处理完成标记：供外部脚本（filebot、hlink 等）过滤 AB 已重命名的任务 (#147)。
const RENAMED_TAG = 'ab:renamed';

/** 通知模型（models/notification.py Notification）。 */
export interface Notification {
  official_title: string;
  season: number;
  episode: number;
  poster_path?: string | null;
}

/** EpisodeFile / SubtitleFile（models/torrent.py）的 TS 形态。 */
export interface EpisodeFileInfo {
  media_path: string;
  group: string | null;
  title: string;
  season: number;
  episode: number;
  suffix: string;
  episode_type: string;
}

export interface SubtitleFileInfo extends EpisodeFileInfo {
  language: string;
}

interface PreparedMediaRename {
  episode: EpisodeFileInfo;
  source_path: string;
  target_path: string;
}

interface MediaRenameReport {
  result: RenameResult;
  prepared?: PreparedMediaRename | null;
  notification?: Notification | null;
}

interface RevisionOwner {
  info: Record<string, any>;
  files: Array<Record<string, any>>;
  identity: RevisionIdentity | null;
}

interface RenameConflictEventLike {
  kind: string;
}

function renameConflictEventCtor() {
  return lazyRequire<{
    RenameConflictEvent: new (
      taskId: string,
      torrentName: string,
      targetPath: string,
      reason: string,
    ) => RenameConflictEventLike;
  }>('../notification/events').RenameConflictEvent;
}

interface TorrentParserLike {
  torrentParser(args: {
    torrent_name?: string;
    torrent_path: string;
    season?: number;
    file_type?: string;
    episode_type?: string;
  }): EpisodeFileInfo | SubtitleFileInfo | null;
}

function torrentParser(): TorrentParserLike {
  // TitleParser.torrentParser(torrentPath, torrentName, season, fileType, episodeType)
  const { TitleParser } = lazyRequire<{
    TitleParser: {
      torrentParser(
        torrentPath: string,
        torrentName?: string | null,
        season?: number | null,
        fileType?: string,
        episodeType?: string,
      ): EpisodeFileInfo | SubtitleFileInfo | null;
    };
  }>('../parser/title-parser');
  return {
    torrentParser: (args) =>
      TitleParser.torrentParser(
        args.torrent_path,
        args.torrent_name ?? null,
        args.season ?? null,
        args.file_type ?? 'media',
        args.episode_type ?? 'episode',
      ),
  };
}

// Per-key async mutex map (asyncio.Lock dict equivalent)
const replacementLocks = new Map<string, Promise<void>>();

async function withReplacementLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = replacementLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const ours = new Promise<void>((r) => (release = r));
  replacementLocks.set(key, prev.then(() => ours));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (replacementLocks.get(key) === ours) {
      replacementLocks.delete(key);
    }
  }
}


/** better-sqlite3 的唯一约束冲突（对应 Python sqlalchemy.IntegrityError 的
 * on-conflict 分支）；其它 DB 错误必须上抛，不可静默 */
function isConstraintError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    (e as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

export class Renamer {
  /** Events raised during the current rename() pass (RenameConflictEvent). */
  readonly events: RenameConflictEventLike[] = [];
  private readonly parser = torrentParser();

  constructor(private readonly client: DownloadClient) {}

  static printResult(torrentCount: number, renameCount: number): void {
    if (renameCount !== 0) {
      logger.log(`Finished checking ${torrentCount} files' name, renamed ${renameCount} files.`);
    }
    logger.debug(`Checked ${torrentCount} files`);
  }

  /** EP0 永不偏移；非正结果回退。 */
  private static adjustEpisode(original: number, episodeOffset: number): number {
    if (original === 0 && episodeOffset !== 0) {
      return 0;
    }
    const adjusted = original + episodeOffset;
    if (adjusted < 0 || (adjusted === 0 && original > 0)) {
      logger.warn(
        `Episode offset ${episodeOffset} would make episode ${original} non-positive, ignoring offset`,
      );
      return original;
    }
    return adjusted;
  }

  /** 半集（12.5）保留小数；整数两位补零。 */
  private static formatEpisode(episode: number): string {
    const ep = Number.isInteger(episode) ? Math.trunc(episode) : episode;
    return ep < 10 ? `0${ep}` : String(ep);
  }

  static genMoviePath(
    fileInfo: EpisodeFileInfo | SubtitleFileInfo,
    movieName: string,
    method: string,
  ): string {
    if (method === 'none' || method === 'subtitle_none') {
      return fileInfo.media_path;
    }
    return `${movieName}${fileInfo.suffix}`;
  }

  static genPath(
    fileInfo: EpisodeFileInfo | SubtitleFileInfo,
    bangumiName: string,
    method: string,
    episodeOffset = 0,
    _seasonOffset = 0,
  ): string {
    // Season comes from the folder name which already includes the offset
    const seasonNum = fileInfo.season;
    const season = seasonNum < 10 ? `0${seasonNum}` : String(seasonNum);
    const episode = Renamer.formatEpisode(Renamer.adjustEpisode(fileInfo.episode, episodeOffset));
    // group_tag 只影响 qB RSS 规则名，从不写进重命名后的文件名——已有做种
    // 媒体库的文件名必须保持稳定（#721）
    if (method === 'none' || method === 'subtitle_none') {
      return fileInfo.media_path;
    }
    const title = fileInfo.title;
    if (fileInfo.episode_type === 'movie') {
      // 电影/剧场版：Title (Year).ext，不使用 SxxExx 编号
      const base = method.includes('advance') ? bangumiName : title;
      if (method.startsWith('subtitle_')) {
        const sub = fileInfo as SubtitleFileInfo;
        return `${base}.${sub.language}${sub.suffix}`;
      }
      return `${base}${fileInfo.suffix}`;
    }
    switch (method) {
      case 'pn':
        return `${title} S${season}E${episode}${fileInfo.suffix}`;
      case 'advance':
        return `${bangumiName} S${season}E${episode}${fileInfo.suffix}`;
      case 'normal':
        logger.warn('Normal rename method is deprecated.');
        return fileInfo.media_path;
      case 'subtitle_pn': {
        const sub = fileInfo as SubtitleFileInfo;
        return `${title} S${season}E${episode}.${sub.language}${sub.suffix}`;
      }
      case 'subtitle_advance': {
        const sub = fileInfo as SubtitleFileInfo;
        return `${bangumiName} S${season}E${episode}.${sub.language}${sub.suffix}`;
      }
      default:
        logger.error(`Unknown rename method: ${method}`);
        return fileInfo.media_path;
    }
  }

  /** 给处理完成的种子打 ab:renamed 标签；打标失败绝不能影响主流程。 */
  private async markRenamed(hash: string, existingTags: string | null | undefined): Promise<void> {
    if (Renamer.hasTag(existingTags, RENAMED_TAG)) return;
    try {
      await this.client.addTag(hash, RENAMED_TAG);
    } catch (e) {
      logger.warn(`Failed to tag ${hash.slice(0, 8)} as renamed: ${e}`);
    }
  }

  async renameFile(args: {
    torrent_name: string;
    media_path: string;
    bangumi_name: string;
    method: string;
    season: number;
    _hash: string;
    episode_offset?: number;
    season_offset?: number;
    episode_type?: string;
    existing_tags?: string | null;
  }): Promise<Notification | null> {
    const report = await this.renameMediaFile(args);
    if (report.result.succeeded && !['none', 'normal'].includes(args.method)) {
      await this.markRenamed(args._hash, args.existing_tags);
    }
    return report.notification ?? null;
  }

  private prepareMediaRename(args: {
    torrent_name: string;
    media_path: string;
    bangumi_name: string;
    method: string;
    season: number;
    episode_offset?: number;
    season_offset?: number;
    episode_type?: string;
  }): PreparedMediaRename | null {
    const ep = this.parser.torrentParser({
      torrent_name: args.torrent_name,
      torrent_path: args.media_path,
      season: args.season,
      episode_type: args.episode_type ?? 'episode',
    });
    if (ep === null) return null;
    return {
      episode: ep,
      source_path: args.media_path,
      target_path: Renamer.genPath(
        ep,
        args.bangumi_name,
        args.method,
        args.episode_offset ?? 0,
        args.season_offset ?? 0,
      ),
    };
  }

  private async executeMediaRename(args: {
    prepared: PreparedMediaRename;
    bangumi_name: string;
    _hash: string;
    episode_offset: number;
  }): Promise<MediaRenameReport> {
    const { prepared } = args;
    if (prepared.source_path === prepared.target_path) {
      return { result: new RenameResult(RenameOutcome.ALREADY_APPLIED), prepared };
    }
    const result = await this.client.renameTorrentFile(
      args._hash,
      prepared.source_path,
      prepared.target_path,
    );
    let notification: Notification | null = null;
    if (result.outcome === RenameOutcome.RENAMED) {
      notification = {
        official_title: args.bangumi_name,
        season: prepared.episode.season,
        episode: Renamer.adjustEpisode(prepared.episode.episode, args.episode_offset),
      };
    }
    return { result, prepared, notification };
  }

  private async renameMediaFile(args: {
    torrent_name: string;
    media_path: string;
    bangumi_name: string;
    method: string;
    season: number;
    _hash: string;
    episode_offset?: number;
    season_offset?: number;
    episode_type?: string;
  }): Promise<MediaRenameReport> {
    const prepared = this.prepareMediaRename(args);
    if (prepared === null) {
      logger.warn(`${args.media_path} parse failed`);
      if (settings.data.bangumi_manage.remove_bad_torrent) {
        await this.client.deleteTorrent(args._hash);
      }
      return {
        result: new RenameResult(RenameOutcome.RETRYABLE_FAILURE, 'media path could not be parsed'),
      };
    }
    return this.executeMediaRename({
      prepared,
      bangumi_name: args.bangumi_name,
      _hash: args._hash,
      episode_offset: args.episode_offset ?? 0,
    });
  }

  /** 多文件电影种子中，非主文件追加原始文件名词干作区分（幂等）。 */
  private static genMovieExtraPath(newPath: string, mediaPath: string): string {
    const dotIdx = newPath.lastIndexOf('.');
    const suffix = dotIdx >= 0 ? newPath.slice(dotIdx) : '';
    const base = suffix ? newPath.slice(0, -suffix.length) : newPath;
    let stem = mediaPath.replace(/\\/g, '/').split('/').pop() ?? mediaPath;
    const stemDot = stem.lastIndexOf('.');
    if (stemDot > 0) stem = stem.slice(0, stemDot);
    const prefix = `${base} - `;
    if (stem.startsWith(prefix)) {
      stem = stem.slice(prefix.length);
    }
    return `${base} - ${stem}${suffix}`;
  }

  async renameMovieFile(args: {
    torrent_name: string;
    media_path: string;
    movie_name: string;
    method: string;
    _hash: string;
  }): Promise<Notification | null> {
    const ep = this.parser.torrentParser({
      torrent_name: args.torrent_name,
      torrent_path: args.media_path,
      episode_type: 'movie',
    });
    if (ep) {
      const newPath = Renamer.genMoviePath(ep, args.movie_name, args.method);
      if (args.media_path !== newPath) {
        const result = await this.client.renameTorrentFile(args._hash, args.media_path, newPath);
        if (result.succeeded) {
          return { official_title: args.movie_name, season: 0, episode: 0 };
        }
      }
    } else {
      logger.warn(`${args.media_path} parse failed (movie)`);
    }
    return null;
  }

  async renameCollection(args: {
    media_list: string[];
    torrent_name?: string;
    bangumi_name: string;
    season: number;
    method: string;
    _hash: string;
    episode_offset?: number;
    season_offset?: number;
    episode_type?: string;
    file_sizes?: Record<string, number> | null;
    existing_tags?: string | null;
    mark_complete?: boolean;
    torrent_info?: Record<string, any> | null;
  }): Promise<boolean> {
    const {
      media_list,
      bangumi_name,
      season,
      method,
      _hash,
      episode_offset = 0,
      season_offset = 0,
      episode_type = 'episode',
      file_sizes = null,
      existing_tags = null,
      mark_complete = true,
      torrent_info = null,
    } = args;
    // 多文件电影种子：所有文件会解析出同一标题，需选出主文件（体积最大者），
    // 其余文件追加区分词干
    let moviePrimary: string | null = null;
    if (episode_type === 'movie') {
      const epList = media_list.filter((p) => isEp(p));
      if (epList.length) {
        if (file_sizes) {
          moviePrimary = epList.reduce((a, b) => ((file_sizes[a] ?? 0) >= (file_sizes[b] ?? 0) ? a : b));
        } else {
          moviePrimary = epList[0];
        }
      }
    }
    let allRenamed = true;
    for (const mediaPath of media_list) {
      if (isEp(mediaPath)) {
        const ep = this.parser.torrentParser({
          torrent_path: mediaPath,
          season,
          episode_type,
        });
        if (ep) {
          let newPath = Renamer.genPath(ep, bangumi_name, method, episode_offset, season_offset);
          if (moviePrimary !== null && mediaPath !== moviePrimary && newPath !== mediaPath) {
            // newPath == mediaPath 说明是 none 等直通方法，不做区分
            newPath = Renamer.genMovieExtraPath(newPath, mediaPath);
          }
          if (mediaPath !== newPath) {
            const prepared: PreparedMediaRename = {
              episode: ep,
              source_path: mediaPath,
              target_path: newPath,
            };
            let result: RenameResult;
            if (torrent_info !== null) {
              const identity = parseRevisionIdentity(String(torrent_info.name ?? ''), {
                bangumi_id: Renamer.parseBangumiIdFromTags(torrent_info.tags as string | null),
                default_season: season,
                episode_offset,
              });
              const report = await this.runOrdinaryRename({
                info: torrent_info,
                prepared,
                identity,
                bangumi_name,
                episode_offset,
              });
              result = report.result;
            } else {
              result = await this.client.renameTorrentFile(_hash, mediaPath, newPath);
            }
            if (!result.succeeded) {
              allRenamed = false;
              logger.warn(`${mediaPath} rename failed`);
            }
          }
        } else {
          // 解析失败的媒体文件不会被重命名——不能算处理完成
          allRenamed = false;
        }
      }
    }
    if (allRenamed && mark_complete && !['none', 'normal'].includes(method)) {
      await this.markRenamed(_hash, existing_tags);
    }
    return allRenamed;
  }

  async renameSubtitles(args: {
    subtitle_list: string[];
    torrent_name: string;
    bangumi_name: string;
    season: number;
    method: string;
    _hash: string;
    episode_offset?: number;
    season_offset?: number;
    episode_type?: string;
  }): Promise<void> {
    const method = `subtitle_${args.method}`;
    for (const subtitlePath of args.subtitle_list) {
      const sub = this.parser.torrentParser({
        torrent_path: subtitlePath,
        torrent_name: args.torrent_name,
        season: args.season,
        file_type: 'subtitle',
        episode_type: args.episode_type ?? 'episode',
      }) as SubtitleFileInfo | null;
      if (sub) {
        const newPath = Renamer.genPath(
          sub,
          args.bangumi_name,
          method,
          args.episode_offset ?? 0,
          args.season_offset ?? 0,
        );
        if (subtitlePath !== newPath) {
          // Skip verification for subtitles to reduce latency
          const result = await this.client.renameTorrentFile(
            args._hash,
            subtitlePath,
            newPath,
            false,
          );
          if (!result.succeeded) {
            logger.warn(`${subtitlePath} rename failed`);
          }
        }
      }
    }
  }

  /** Extract bangumi_id from torrent tags ('ab:ID' format). */
  static parseBangumiIdFromTags(tags: string | string[] | null | undefined): number | null {
    if (!tags) return null;
    // qB 返回逗号字符串；mock 可能是数组（Python 端同形，仅对字符串语义对齐）
    const parts = Array.isArray(tags) ? tags : tags.split(',');
    for (const rawTag of parts) {
      const tag = String(rawTag).trim();
      if (tag.startsWith('ab:')) {
        // Python int() 严格（'12a'/'12.5' 抛 ValueError 跳过该 tag）
        const rest = tag.slice(3);
        if (/^-?\d+$/.test(rest)) return parseInt(rest, 10);
      }
    }
    return null;
  }

  private static hasTag(tags: string | string[] | null | undefined, expected: string): boolean {
    if (!tags) return false;
    const parts = Array.isArray(tags) ? tags : tags.split(',');
    return parts.map((t) => String(t).trim()).includes(expected);
  }

  private static retryAt(): string {
    return utcInSeconds(PENDING_RENAME_COOLDOWN);
  }

  private static retryIsDue(value: string | null): boolean {
    if (value === null) return true;
    return value <= utcNow();
  }

  private downloaderType(): string {
    const configured = settings.data.downloader.type;
    const downloaderType =
      typeof configured === 'string' ? configured : this.client.constructor.name.toLowerCase();
    // Python 端 Downloader.host 是 expandvars 的 property；这里同样展开后再
    // 哈希，否则 $VAR 配置会生成与 Python 不一致的 rename_operation 身份
    const host = expandEnv(settings.data.downloader.host);
    if (!host) return downloaderType;
    const instanceHash = crypto
      .createHash('sha256')
      .update(host.trim().toLowerCase())
      .digest('hex')
      .slice(0, 12);
    return `${downloaderType}:${instanceHash}`;
  }

  /** Find downloader tasks that already own an incoming canonical path. */
  private async findRevisionOwners(args: {
    incoming: Record<string, any>;
    target_path: string;
    all_infos: Array<Record<string, any>>;
    episode_offset: number;
  }): Promise<{ incomingIdentity: RevisionIdentity | null; owners: RevisionOwner[] }> {
    const { incoming, target_path, all_infos, episode_offset } = args;
    const incomingId = Renamer.parseBangumiIdFromTags(incoming.tags);
    const [, incomingSeason] = pathToBangumi(incoming.save_path ?? '', incoming.name ?? '');
    const incomingIdentity = parseRevisionIdentity(incoming.name ?? '', {
      bangumi_id: incomingId,
      default_season: incomingSeason,
      episode_offset,
    });
    if (incomingId === null) {
      return { incomingIdentity, owners: [] };
    }

    const savePath = normalizeSavePath(incoming.save_path ?? '');
    const candidates = all_infos.filter(
      (info) =>
        info.hash !== incoming.hash &&
        normalizeSavePath(info.save_path ?? '') === savePath &&
        Renamer.parseBangumiIdFromTags(info.tags) === incomingId,
    );
    if (!candidates.length) {
      return { incomingIdentity, owners: [] };
    }

    const candidateFiles = await Promise.all(
      candidates.map((info) => this.client.getTorrentFiles(info.hash)),
    );
    const owners: RevisionOwner[] = [];
    const normalizedTarget = target_path.replace(/\\/g, '/');
    for (const [i, info] of candidates.entries()) {
      const files = candidateFiles[i];
      // 合集 owner 必须使替换不可行，而不是从 owner 计数里消失
      const ownsTarget = files.some(
        (item) => String(item.name ?? '').replace(/\\/g, '/') === normalizedTarget,
      );
      if (!ownsTarget) continue;
      const [, oldSeason] = pathToBangumi(info.save_path ?? '', info.name ?? '');
      owners.push({
        info,
        files,
        identity: parseRevisionIdentity(info.name ?? '', {
          bangumi_id: incomingId,
          default_season: oldSeason,
          episode_offset,
        }),
      });
    }
    return { incomingIdentity, owners };
  }

  private buildOperation(args: {
    info: Record<string, any>;
    prepared: PreparedMediaRename;
    identity: RevisionIdentity | null;
    kind: string;
    state: string;
    owner?: RevisionOwner | null;
    reason?: string | null;
  }): NewRenameOperationRow {
    const { info, prepared, identity, kind, state, owner = null, reason = null } = args;
    const ownerIdentity = owner?.identity ?? null;
    const metadata = {
      new_torrent_name: info.name ?? '',
      old_torrent_name: owner ? owner.info.name ?? '' : null,
    };
    return {
      downloader_type: this.downloaderType(),
      kind,
      state,
      new_task_id: info.hash,
      old_task_id: owner ? owner.info.hash : null,
      save_path: normalizeSavePath(info.save_path ?? ''),
      source_path: prepared.source_path,
      target_path: prepared.target_path,
      staged_path:
        owner && ownerIdentity
          ? replacementStagedPath(prepared.target_path, {
              old_task_id: owner.info.hash,
              old_revision: ownerIdentity.revision,
            })
          : null,
      bangumi_id: identity ? identity.bangumi_id : null,
      media_type: identity ? String(identity.media_type) : null,
      season: identity ? identity.season : null,
      episode: identity ? Number(identity.episode) : null,
      group_name: identity ? identity.group : null,
      resolution: identity ? identity.resolution : null,
      old_revision: ownerIdentity ? ownerIdentity.revision : null,
      new_revision: identity ? identity.revision : null,
      revision_metadata: JSON.stringify(metadata),
      attempt_count: 0,
      retry_at: null,
      lease_owner: null,
      lease_expires_at: null,
      notified_at: null,
      last_error: reason,
      created_at: utcNow(),
      updated_at: utcNow(),
    };
  }

  private async emitConflictOnce(
    operation: RenameOperationRow,
    torrentName: string,
    reason: string,
  ): Promise<void> {
    const claimed = db.rename_operation.markNotified(operation.id);
    if (claimed) {
      const RenameConflictEvent = renameConflictEventCtor();
      this.events.push(
        new RenameConflictEvent(operation.new_task_id, torrentName, operation.target_path, reason),
      );
    }
  }

  private async persistConflict(args: {
    info: Record<string, any>;
    prepared: PreparedMediaRename;
    identity: RevisionIdentity | null;
    reason: string;
    owner?: RevisionOwner | null;
  }): Promise<RenameOperationRow | undefined> {
    const operation = this.buildOperation({
      ...args,
      kind: 'conflict',
      state: 'conflict',
    });
    const active = db.rename_operation.getByTarget({
      downloader_type: operation.downloader_type,
      save_path: operation.save_path,
      target_path: operation.target_path,
    });
    let row: RenameOperationRow | undefined;
    if (active !== undefined && active.new_task_id !== operation.new_task_id) {
      logger.warn(
        `Rename target already reserved by task ${active.new_task_id.slice(0, 8)}: ${operation.target_path}`,
      );
      return active;
    }
    try {
      row = db.rename_operation.upsertConflict(operation).row;
    } catch (e) {
      if (!isConstraintError(e)) throw e;
      row = db.rename_operation.getByTarget({
        downloader_type: operation.downloader_type,
        save_path: operation.save_path,
        target_path: operation.target_path,
      });
    }
    if (row !== undefined && row.new_task_id === args.info.hash) {
      await this.emitConflictOnce(row, String(args.info.name ?? ''), args.reason);
    }
    return row;
  }

  private async setOperationState(
    operation: RenameOperationRow,
    state: string,
    opts: { retry?: boolean; error?: string | null } = {},
  ): Promise<RenameOperationRow> {
    const extra = {
      retry_at: opts.retry ? Renamer.retryAt() : null,
      last_error: opts.error ?? null,
    };
    if (operation.kind === 'replacement' && operation.lease_owner) {
      const updated = db.rename_operation.setStateClaimed(
        operation.id,
        operation.lease_owner,
        state as never,
        extra,
      );
      if (updated === undefined) {
        throw new Error('replacement lease was lost before state commit');
      }
      return updated;
    }
    const updated = db.rename_operation.setState(operation.id, state as never, extra);
    return updated ?? operation;
  }

  private async replacementConflict(
    operation: RenameOperationRow,
    info: Record<string, any>,
    reason: string,
  ): Promise<void> {
    const updated = await this.setOperationState(operation, 'conflict', { error: reason });
    await this.emitConflictOnce(updated, String(info.name ?? ''), reason);
  }

  /** Advance a staged V1 -> V2 replacement saga as far as possible. */
  private async advanceReplacement(args: {
    operation: RenameOperationRow;
    info: Record<string, any>;
    prepared: PreparedMediaRename;
    all_infos: Array<Record<string, any>>;
    bangumi_name: string;
    episode_offset: number;
    existing_tags?: string | null;
  }): Promise<Notification | null> {
    const { info, prepared, all_infos, bangumi_name, episode_offset } = args;
    const existingTags = args.existing_tags ?? null;
    const key = `${args.operation.downloader_type}|${args.operation.save_path}|${args.operation.target_path}`;
    return withReplacementLock(key, async () => {
      const current = db.rename_operation.get(args.operation.id);
      if (!current) return null;
      let operation = current;
      if (!Renamer.retryIsDue(operation.retry_at)) return null;

      const infoByHash = new Map(all_infos.map((item) => [item.hash as string, item]));
      const stagedPath = operation.staged_path;
      if (!stagedPath || !operation.old_task_id) {
        await this.replacementConflict(operation, info, 'replacement operation is missing old owner metadata');
        return null;
      }
      const oldTaskId = operation.old_task_id;

      // A bounded loop lets the normal successful path finish in one tick,
      // while every external action is verified and persisted separately.
      for (let i = 0; i < 6; i++) {
        let state = operation.state;
        if (['planned', 'old_staged', 'new_promoted', 'old_removed'].includes(state)) {
          const claimed = db.rename_operation.claimReplacementLease(
            operation.id,
            crypto.randomUUID().replace(/-/g, ''),
          );
          if (claimed === undefined) return null;
          operation = claimed;
          state = operation.state;
        }
        if (state === 'conflict') {
          await this.emitConflictOnce(
            operation,
            String(info.name ?? ''),
            operation.last_error ?? 'rename conflict',
          );
          return null;
        }

        if (state === 'planned') {
          const oldInfo = infoByHash.get(oldTaskId);
          if (oldInfo === undefined) {
            await this.replacementConflict(operation, info, 'old revision task disappeared before staging');
            return null;
          }
          const oldFiles = await this.client.getTorrentFiles(oldTaskId);
          const oldNames = new Set(oldFiles.map((item) => String(item.name ?? '').replace(/\\/g, '/')));
          if (oldNames.has(stagedPath)) {
            operation = await this.setOperationState(operation, 'old_staged');
            continue;
          }
          if (!oldNames.has(operation.target_path)) {
            await this.replacementConflict(operation, info, 'old revision no longer owns the canonical path');
            return null;
          }
          const result = await this.client.renameTorrentFile(oldTaskId, operation.target_path, stagedPath);
          if (result.succeeded) {
            operation = await this.setOperationState(operation, 'old_staged');
            continue;
          }
          if (result.outcome === RenameOutcome.DESTINATION_EXISTS) {
            await this.replacementConflict(operation, info, 'temporary staging path already exists');
            return null;
          }
          operation = await this.setOperationState(operation, 'planned', {
            retry: true,
            error: result.detail ?? 'failed to stage old revision',
          });
          return null;
        }

        if (state === 'old_staged') {
          let newFiles = await this.client.getTorrentFiles(operation.new_task_id);
          const newNames = new Set(newFiles.map((item) => String(item.name ?? '').replace(/\\/g, '/')));
          if (newNames.has(operation.target_path)) {
            operation = await this.setOperationState(operation, 'new_promoted');
            continue;
          }
          if (!newNames.has(operation.source_path)) {
            const rollback = await this.client.renameTorrentFile(oldTaskId, stagedPath, operation.target_path);
            if (rollback.succeeded) {
              await this.replacementConflict(
                operation,
                info,
                'new revision source disappeared after staging; V1 was restored',
              );
            } else {
              await this.setOperationState(operation, 'old_staged', {
                retry: true,
                error: `new revision source disappeared and V1 rollback needs retry: ${rollback.detail ?? rollback.outcome}`,
              });
            }
            return null;
          }
          const result = await this.client.renameTorrentFile(
            operation.new_task_id,
            operation.source_path,
            operation.target_path,
          );
          if (result.succeeded) {
            operation = await this.setOperationState(operation, 'new_promoted');
            continue;
          }

          // Reconcile once more before rollback: a transport failure may
          // happen after the downloader applied the promotion.
          newFiles = await this.client.getTorrentFiles(operation.new_task_id);
          if (
            newFiles.some((item) => String(item.name ?? '').replace(/\\/g, '/') === operation.target_path)
          ) {
            operation = await this.setOperationState(operation, 'new_promoted');
            continue;
          }

          const rollback = await this.client.renameTorrentFile(oldTaskId, stagedPath, operation.target_path);
          if (rollback.succeeded) {
            if (result.outcome === RenameOutcome.DESTINATION_EXISTS) {
              await this.replacementConflict(
                operation,
                info,
                'V2 promotion target is owned by an unknown file; V1 was restored',
              );
              return null;
            }
            operation = await this.setOperationState(operation, 'planned', {
              retry: true,
              error: result.detail ?? 'promotion failed and V1 was restored',
            });
            return null;
          }
          if (rollback.outcome === RenameOutcome.DESTINATION_EXISTS) {
            await this.replacementConflict(
              operation,
              info,
              'V2 promotion and V1 rollback both found an occupied canonical target',
            );
            return null;
          }
          operation = await this.setOperationState(operation, 'old_staged', {
            retry: true,
            error: `promotion failed and rollback needs retry: ${rollback.detail ?? rollback.outcome}`,
          });
          return null;
        }

        if (state === 'new_promoted') {
          let oldExists = await this.client.torrentExists(oldTaskId);
          if (oldExists === null) {
            operation = await this.setOperationState(operation, 'new_promoted', {
              retry: true,
              error: 'new revision is live; old task existence could not be verified',
            });
            return null;
          }
          if (oldExists) {
            const removed = await this.client.deleteTorrent(oldTaskId, true);
            if (!removed) {
              operation = await this.setOperationState(operation, 'new_promoted', {
                retry: true,
                error: 'new revision is live; old task cleanup failed',
              });
              return null;
            }
            oldExists = await this.client.torrentExists(oldTaskId);
            if (oldExists !== false) {
              operation = await this.setOperationState(operation, 'new_promoted', {
                retry: true,
                error: 'old task deletion was accepted but is not yet observable',
              });
              return null;
            }
          }
          operation = await this.setOperationState(operation, 'old_removed');
          continue;
        }

        if (state === 'old_removed') {
          operation = await this.setOperationState(operation, 'done');
          continue;
        }

        if (state === 'done') {
          await this.markRenamed(String(info.hash), existingTags);
          const notify = db.rename_operation.markNotified(operation.id);
          if (!notify) return null;
          return {
            official_title: bangumi_name,
            season: prepared.episode.season,
            episode: Renamer.adjustEpisode(prepared.episode.episode, episode_offset),
          };
        }

        // `retry` is only used by ordinary renames. A replacement row reaching
        // it is malformed and must stop rather than guessing.
        await this.replacementConflict(operation, info, `unexpected replacement state: ${state}`);
        return null;
      }
      return null;
    });
  }

  private async startReplacement(args: {
    info: Record<string, any>;
    prepared: PreparedMediaRename;
    identity: RevisionIdentity;
    owner: RevisionOwner;
    all_infos: Array<Record<string, any>>;
    bangumi_name: string;
    episode_offset: number;
    existing_tags?: string | null;
  }): Promise<Notification | null> {
    const { info, prepared, identity, owner } = args;
    const operation = this.buildOperation({
      info,
      prepared,
      identity,
      kind: 'replacement',
      state: 'planned',
      owner,
    });
    let row: RenameOperationRow | undefined;
    try {
      row = db.rename_operation.getOrCreate(operation).row;
    } catch (e) {
      if (!isConstraintError(e)) throw e;
      row = db.rename_operation.getByTarget({
        downloader_type: operation.downloader_type,
        save_path: operation.save_path,
        target_path: operation.target_path,
      });
    }
    if (row === undefined || row.new_task_id !== info.hash) {
      await this.persistConflict({
        info,
        prepared,
        identity,
        owner,
        reason: 'canonical target is reserved by another rename operation',
      });
      return null;
    }
    return this.advanceReplacement({
      operation: row,
      info,
      prepared,
      all_infos: args.all_infos,
      bangumi_name: args.bangumi_name,
      episode_offset: args.episode_offset,
      existing_tags: args.existing_tags,
    });
  }

  /** Recover an active saga whose incoming task left the normal snapshot. */
  private async recoverMissingReplacement(
    operation: RenameOperationRow,
    allInfos: Array<Record<string, any>>,
  ): Promise<void> {
    if (allInfos.some((info) => info.hash === operation.new_task_id)) {
      return;
    }
    const claimed = db.rename_operation.claimReplacementLease(
      operation.id,
      crypto.randomUUID().replace(/-/g, ''),
    );
    if (claimed === undefined) return;
    let op = claimed;
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(op.revision_metadata ?? '{}');
    } catch {
      metadata = {};
    }
    const info = {
      hash: op.new_task_id,
      name: (metadata.new_torrent_name as string) || op.new_task_id,
    };
    if (op.state === 'old_staged' && op.old_task_id) {
      const rollback = await this.client.renameTorrentFile(
        op.old_task_id,
        op.staged_path ?? '',
        op.target_path,
      );
      if (rollback.succeeded) {
        await this.replacementConflict(op, info, 'incoming revision task disappeared; V1 was restored');
        return;
      }
      if (rollback.outcome === RenameOutcome.DESTINATION_EXISTS) {
        await this.replacementConflict(
          op,
          info,
          'incoming revision task disappeared while the canonical path remained occupied',
        );
        return;
      }
      await this.setOperationState(op, 'old_staged', {
        retry: true,
        error: `incoming revision task disappeared and V1 rollback needs retry: ${rollback.detail ?? rollback.outcome}`,
      });
      return;
    }
    if (op.state === 'old_removed') {
      await this.setOperationState(op, 'done');
      return;
    }
    await this.replacementConflict(
      op,
      info,
      'incoming revision task disappeared during replacement; automatic deletion is stopped',
    );
  }

  /** Claim and execute one non-replacement rename exactly once at a time. */
  private async runOrdinaryRename(args: {
    info: Record<string, any>;
    prepared: PreparedMediaRename;
    identity: RevisionIdentity | null;
    bangumi_name: string;
    episode_offset: number;
  }): Promise<MediaRenameReport> {
    const { info, prepared, identity, bangumi_name, episode_offset } = args;
    const template = this.buildOperation({
      info,
      prepared,
      identity,
      kind: 'conflict',
      state: 'retry',
    });
    const key = `${template.downloader_type}|${template.save_path}|${template.target_path}`;
    return withReplacementLock(key, async () => {
      let active = db.rename_operation.getByTarget({
        downloader_type: template.downloader_type,
        save_path: template.save_path,
        target_path: template.target_path,
      });
      if (active !== undefined && active.new_task_id !== info.hash) {
        return {
          result: new RenameResult(
            RenameOutcome.DESTINATION_EXISTS,
            'canonical target is reserved by another operation',
          ),
          prepared,
        };
      }
      if (active === undefined) {
        try {
          active = db.rename_operation.getOrCreate(template).row;
        } catch (e) {
          if (!isConstraintError(e)) throw e;
          active = db.rename_operation.getByTarget({
            downloader_type: template.downloader_type,
            save_path: template.save_path,
            target_path: template.target_path,
          });
        }
      }
      if (active === undefined) {
        return {
          result: new RenameResult(RenameOutcome.RETRYABLE_FAILURE, 'could not reserve rename operation'),
          prepared,
        };
      }
      if (active.state === 'done') {
        return { result: new RenameResult(RenameOutcome.ALREADY_APPLIED), prepared };
      }
      let conflict: RenameOperationRow | null = null;
      let claimed: RenameOperationRow | undefined;
      if (active.state === 'conflict') {
        conflict = active;
        claimed = undefined;
      } else {
        if (active.state === 'running') {
          const recovered = db.rename_operation.recoverStaleRunning(
            active.id,
            // before = now - cooldown
            utcInSeconds(-PENDING_RENAME_COOLDOWN),
          );
          if (!recovered) {
            return {
              result: new RenameResult(RenameOutcome.RETRYABLE_FAILURE, 'rename operation is already running'),
              prepared,
            };
          }
          active = db.rename_operation.get(active.id) ?? active;
        }
        if (active.state === 'retry' && !Renamer.retryIsDue(active.retry_at)) {
          return {
            result: new RenameResult(
              RenameOutcome.RETRYABLE_FAILURE,
              active.last_error ?? 'rename retry cooldown',
            ),
            prepared,
          };
        }
        claimed = db.rename_operation.claim(active.id, ['retry'], 'running');
      }

      if (conflict !== null) {
        await this.emitConflictOnce(
          conflict,
          String(info.name ?? ''),
          conflict.last_error ?? 'target already exists',
        );
        return {
          result: new RenameResult(RenameOutcome.DESTINATION_EXISTS, conflict.last_error),
          prepared,
        };
      }
      if (claimed === undefined) {
        return {
          result: new RenameResult(RenameOutcome.RETRYABLE_FAILURE, 'rename operation was claimed by another worker'),
          prepared,
        };
      }

      // The downloader may have applied the previous rename just before the
      // process crashed, leaving the DB row in `running`. Reconcile against
      // its own file list before sending the external mutation again.
      const currentFiles = await this.client.getTorrentFiles(String(info.hash));
      const currentNames = new Set(currentFiles.map((item) => String(item.name ?? '').replace(/\\/g, '/')));
      if (currentNames.has(prepared.target_path) && !currentNames.has(prepared.source_path)) {
        await this.setOperationState(claimed, 'done');
        return { result: new RenameResult(RenameOutcome.ALREADY_APPLIED), prepared };
      }

      const report = await this.executeMediaRename({
        prepared,
        bangumi_name,
        _hash: String(info.hash),
        episode_offset,
      });
      if (report.result.succeeded) {
        await this.setOperationState(claimed, 'done');
        return report;
      }
      if (report.result.outcome === RenameOutcome.DESTINATION_EXISTS) {
        const conflictRow = await this.setOperationState(claimed, 'conflict', {
          error: report.result.detail ?? 'target path already exists',
        });
        await this.emitConflictOnce(
          conflictRow,
          String(info.name ?? ''),
          conflictRow.last_error ?? 'target path already exists',
        );
        return report;
      }
      await this.setOperationState(claimed, 'retry', {
        retry: true,
        error: report.result.detail ?? 'rename failed verification',
      });
      return report;
    });
  }

  private async processSingleTorrent(args: {
    info: Record<string, any>;
    files: Array<Record<string, any>>;
    media_path: string;
    all_infos: Array<Record<string, any>>;
    bangumi_name: string;
    season: number;
    method: string;
    episode_offset: number;
    season_offset: number;
    episode_type: string;
  }): Promise<MediaRenameReport> {
    const { info, files, media_path, all_infos, bangumi_name, season, method, episode_offset } = args;
    const prepared = this.prepareMediaRename({
      torrent_name: info.name,
      media_path,
      bangumi_name,
      method,
      season,
      episode_offset,
      season_offset: args.season_offset,
      episode_type: args.episode_type,
    });
    if (prepared === null) {
      logger.warn(`${media_path} parse failed`);
      if (settings.data.bangumi_manage.remove_bad_torrent) {
        await this.client.deleteTorrent(String(info.hash));
      }
      return {
        result: new RenameResult(RenameOutcome.RETRYABLE_FAILURE, 'media path could not be parsed'),
      };
    }

    const incomingId = Renamer.parseBangumiIdFromTags(info.tags);
    const identity = parseRevisionIdentity(String(info.name ?? ''), {
      bangumi_id: incomingId,
      default_season: season,
      episode_offset,
    });
    const savePath = normalizeSavePath(info.save_path ?? '');
    const active = db.rename_operation.getByTarget({
      downloader_type: this.downloaderType(),
      save_path: savePath,
      target_path: prepared.target_path,
    });

    if (active !== undefined) {
      if (active.new_task_id !== info.hash) {
        return {
          result: new RenameResult(
            RenameOutcome.DESTINATION_EXISTS,
            'canonical target is reserved by another operation',
          ),
          prepared,
        };
      }
      if (active.state === 'conflict') {
        await this.emitConflictOnce(active, String(info.name ?? ''), active.last_error ?? 'target already exists');
        return {
          result: new RenameResult(RenameOutcome.DESTINATION_EXISTS, active.last_error),
          prepared,
        };
      }
      if (active.kind === 'replacement' && active.state !== 'done') {
        const notification = await this.advanceReplacement({
          operation: active,
          info,
          prepared,
          all_infos,
          bangumi_name,
          episode_offset,
          existing_tags: info.tags,
        });
        const refreshed = db.rename_operation.get(active.id);
        const finished = refreshed !== undefined && refreshed.state === 'done';
        return {
          result: new RenameResult(
            finished ? RenameOutcome.RENAMED : RenameOutcome.RETRYABLE_FAILURE,
            finished ? null : (refreshed?.last_error ?? null),
          ),
          prepared,
          notification,
        };
      }
      if (active.state === 'retry' && !Renamer.retryIsDue(active.retry_at)) {
        return {
          result: new RenameResult(
            RenameOutcome.RETRYABLE_FAILURE,
            active.last_error ?? 'rename retry cooldown',
          ),
          prepared,
        };
      }
      if (active.state === 'done') {
        return { result: new RenameResult(RenameOutcome.ALREADY_APPLIED), prepared };
      }
    }

    const { incomingIdentity, owners } = await this.findRevisionOwners({
      incoming: info,
      target_path: prepared.target_path,
      all_infos,
      episode_offset,
    });
    if (owners.length) {
      const owner = owners.length === 1 ? owners[0] : null;
      let reason = 'canonical path has more than one downloader owner';
      const canReplace = Boolean(
        owner !== null &&
          files.length === 1 &&
          owner.files.length === 1 &&
          incomingIdentity !== null &&
          owner.identity !== null &&
          isStrictUpgrade(owner.identity, incomingIdentity),
      );
      if (settings.data.bangumi_manage.revision_conflict_policy === 'replace' && canReplace) {
        const notification = await this.startReplacement({
          info,
          prepared,
          identity: incomingIdentity!,
          owner: owner!,
          all_infos,
          bangumi_name,
          episode_offset,
          existing_tags: info.tags,
        });
        const replacement = db.rename_operation.getByTarget({
          downloader_type: this.downloaderType(),
          save_path: savePath,
          target_path: prepared.target_path,
        });
        const finished = replacement !== undefined && replacement.state === 'done';
        return {
          result: new RenameResult(
            finished ? RenameOutcome.RENAMED : RenameOutcome.RETRYABLE_FAILURE,
            replacement?.last_error ?? null,
          ),
          prepared,
          notification,
        };
      }

      if (owners.length === 1 && owner !== null) {
        if (files.length !== 1 || owner.files.length !== 1) {
          reason = 'automatic replacement requires two single-file torrents';
        } else if (incomingIdentity === null || owner.identity === null) {
          reason = 'revision identity is incomplete';
        } else if (!isStrictUpgrade(owner.identity, incomingIdentity)) {
          reason = 'existing and incoming releases are not a strict revision upgrade';
        } else {
          reason = 'revision conflict policy is hold';
        }
      }
      await this.persistConflict({
        info,
        prepared,
        identity: incomingIdentity,
        owner,
        reason,
      });
      return {
        result: new RenameResult(RenameOutcome.DESTINATION_EXISTS, reason),
        prepared,
      };
    }

    return this.runOrdinaryRename({
      info,
      prepared,
      identity,
      bangumi_name,
      episode_offset,
    });
  }

  /** Batch lookup offsets: hash -> (episode_offset, season_offset, episode_type). */
  private async batchLookupOffsets(
    torrentsInfo: Array<Record<string, any>>,
  ): Promise<Map<string, [number, number, string]>> {
    const result = new Map<string, [number, number, string]>();
    if (!torrentsInfo.length) return result;

    try {
      // Collect all hashes for batch query
      const hashes = torrentsInfo.map((info) => String(info.hash));
      const torrentRecords = db.torrent.searchByQbHashes(hashes);
      const hashToBangumiId = new Map<string, number>();
      for (const r of torrentRecords) {
        if (r.qb_hash && r.bangumi_id) hashToBangumiId.set(r.qb_hash, r.bangumi_id);
      }

      const bangumiIdsToFetch = new Set(hashToBangumiId.values());

      // Also collect bangumi IDs from tags
      const tagBangumiIds = new Map<string, number>();
      for (const info of torrentsInfo) {
        const bangumiId = Renamer.parseBangumiIdFromTags(info.tags ?? '');
        if (bangumiId) {
          tagBangumiIds.set(String(info.hash), bangumiId);
          bangumiIdsToFetch.add(bangumiId);
        }
      }

      // Batch fetch all bangumi records
      const bangumiMap = new Map<number, NonNullable<ReturnType<typeof db.bangumi.searchId>>>();
      if (bangumiIdsToFetch.size) {
        for (const b of db.bangumi.searchIds([...bangumiIdsToFetch])) {
          if (b && !b.deleted) bangumiMap.set(b.id, b);
        }
      }

      // Resolve via qb_hash/tag first (both already batched above).
      const unresolved: Array<Record<string, any>> = [];
      for (const info of torrentsInfo) {
        const torrentHash = String(info.hash);

        // 1. Try by qb_hash
        let bangumiId = hashToBangumiId.get(torrentHash);
        if (bangumiId && bangumiMap.has(bangumiId)) {
          const b = bangumiMap.get(bangumiId)!;
          result.set(torrentHash, [b.episode_offset, b.season_offset, b.episode_type]);
          continue;
        }

        // 2. Try by tag
        bangumiId = tagBangumiIds.get(torrentHash);
        if (bangumiId && bangumiMap.has(bangumiId)) {
          const b = bangumiMap.get(bangumiId)!;
          result.set(torrentHash, [b.episode_offset, b.season_offset, b.episode_type]);
          continue;
        }

        unresolved.push(info);
      }

      // 3./4. Fall back to name/save_path matching in memory.
      if (unresolved.length) {
        const bangumiList = db.bangumi.searchAll();
        const savePathIndex = buildSavePathIndex(bangumiList);
        for (const info of unresolved) {
          const torrentHash = String(info.hash);
          const torrentName = String(info.name);
          const savePath = String(info.save_path);

          let bangumi = matchBangumiInList(torrentName, bangumiList);
          if (!bangumi) {
            bangumi = savePathIndex.get(normalizeSavePath(savePath));
          }

          if (bangumi) {
            result.set(torrentHash, [bangumi.episode_offset, bangumi.season_offset, bangumi.episode_type]);
          } else {
            // Default: no offset
            result.set(torrentHash, [0, 0, 'episode']);
          }
        }
      }
    } catch (e) {
      const missing = torrentsInfo.filter((info) => !result.has(String(info.hash)));
      logger.warn(
        `Batch offset lookup failed; skipping rename for ${missing.length} torrent(s) this cycle: ${e}`,
      );
      // Leave the unresolved torrents out of the map entirely so rename()
      // skips them instead of silently defaulting to (0, 0).
    }

    return result;
  }

  /** Main rename pass (rename_tick body). Returns new-episode notifications. */
  async rename(): Promise<Notification[]> {
    logger.debug('Start rename process.');
    const renameMethod = settings.data.bangumi_manage.rename_method;
    const pendingInfos = await this.client.getTorrentInfo();
    // Owner counting and Saga recovery must see tasks outside the normal
    // Bangumi/completed filter (collections, paused tasks, changed category).
    let allInfos = await this.client.getTorrentInfo(null, null);
    const infoByHash = new Map<string, Record<string, any>>();
    for (const info of allInfos) infoByHash.set(String(info.hash), info);
    for (const info of pendingInfos) {
      if (!infoByHash.has(String(info.hash))) infoByHash.set(String(info.hash), info);
    }
    allInfos = [...infoByHash.values()];
    const activeReplacements = db.rename_operation.listActiveReplacements();
    const activeReplacementIds = new Set(activeReplacements.map((op) => op.new_task_id));
    for (const operation of activeReplacements) {
      if (!infoByHash.has(operation.new_task_id)) {
        const incomingExists = await this.client.torrentExists(operation.new_task_id);
        if (incomingExists === null || incomingExists) {
          // A failed/incomplete bulk snapshot must never be treated as proof
          // that the incoming task disappeared.
          continue;
        }
        await this.recoverMissingReplacement(operation, allInfos);
        continue;
      }
      if (!pendingInfos.some((info) => info.hash === operation.new_task_id)) {
        pendingInfos.push(infoByHash.get(operation.new_task_id)!);
      }
    }
    // `ab:renamed` is a real terminal marker; a later V2 still sees it lazily
    // as a possible owner.
    const torrentsInfo = pendingInfos.filter(
      (info) =>
        activeReplacementIds.has(String(info.hash)) ||
        !Renamer.hasTag(info.tags as string | undefined, RENAMED_TAG),
    );
    const renamedInfo: Notification[] = [];
    if (!torrentsInfo.length) {
      logger.debug('Rename process finished: no pending torrents');
      return renamedInfo;
    }

    const allFiles = await Promise.all(
      torrentsInfo.map((info) => this.client.getTorrentFiles(String(info.hash))),
    );
    const offsetMap = await this.batchLookupOffsets(torrentsInfo);
    for (const [i, info] of torrentsInfo.entries()) {
      const torrentHash = String(info.hash);
      const torrentName = String(info.name);
      const savePath = String(info.save_path);
      const files = allFiles[i];
      if (!offsetMap.has(torrentHash)) {
        // Offset lookup failed for this torrent this cycle — skip renaming
        // rather than guessing offset (0, 0).
        logger.warn(`Skipping ${torrentName}: offset lookup failed this cycle`);
        continue;
      }
      const [mediaList, subtitleList] = checkFiles(files);
      const [bangumiName, season] = pathToBangumi(savePath, torrentName);
      const [episodeOffset, seasonOffset, episodeType] = offsetMap.get(torrentHash)!;
      const kwargs = {
        torrent_name: torrentName,
        bangumi_name: bangumiName,
        method: renameMethod,
        season,
        _hash: torrentHash,
        episode_offset: episodeOffset,
        season_offset: seasonOffset,
        episode_type: episodeType,
        existing_tags: (info.tags as string) ?? null,
      };
      if (mediaList.length === 1) {
        const report = await this.processSingleTorrent({
          info,
          files,
          media_path: mediaList[0],
          all_infos: allInfos,
          bangumi_name: bangumiName,
          season,
          method: renameMethod,
          episode_offset: episodeOffset,
          season_offset: seasonOffset,
          episode_type: episodeType,
        });
        if (report.notification) {
          renamedInfo.push(report.notification);
        }
        if (report.result.succeeded) {
          if (subtitleList.length) {
            await this.renameSubtitles({ subtitle_list: subtitleList, ...kwargs });
          }
          if (!['none', 'normal'].includes(renameMethod)) {
            await this.markRenamed(torrentHash, info.tags as string | undefined);
          }
        }
      } else if (mediaList.length > 1) {
        logger.log('Start rename collection');
        const fileSizes: Record<string, number> = {};
        for (const f of files) {
          fileSizes[String(f.name)] = (f.size as number) || 0;
        }
        const collectionComplete = await this.renameCollection({
          media_list: mediaList,
          file_sizes: fileSizes,
          mark_complete: false,
          torrent_info: info,
          ...kwargs,
        });
        if (collectionComplete && subtitleList.length) {
          await this.renameSubtitles({ subtitle_list: subtitleList, ...kwargs });
        }
        if (collectionComplete) {
          if (!['none', 'normal'].includes(renameMethod)) {
            await this.markRenamed(torrentHash, info.tags as string | undefined);
          }
          await this.client.setCategory(torrentHash, 'BangumiCollection');
        }
      } else {
        logger.warn(`${torrentName} has no media file`);
      }
    }
    // 清理 30 天前的 done 记录
    db.rename_operation.pruneDone(utcInSeconds(-30 * 24 * 60 * 60));
    logger.debug('Rename process finished.');
    return renamedInfo;
  }
}

export { AddResult };
