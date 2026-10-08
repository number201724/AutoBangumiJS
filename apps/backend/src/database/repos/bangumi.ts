/**
 * Bangumi repository — 1:1 port of module/database/bangumi.py,
 * including the in-memory torrent-name matcher.
 */
import { Logger } from '@nestjs/common';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { getDb, getSqlite } from '../database';
import { aria2Gid, bangumi, torrent } from '../schema';
import { MediaType, type ParsedRelease } from '../../parser/types';

const logger = new Logger('BangumiDatabase');

export type BangumiRow = typeof bangumi.$inferSelect;
export type { NewBangumiRow } from "../schema";
import type { NewBangumiRow } from '../schema';

/**
 * Python Bangumi 模型的客户端默认值（SQLModel 在实例化时填充；drizzle
 * 需要在 insert 前补齐，否则 NOT NULL 列会以 NULL 写入失败）。
 */
export function withBangumiDefaults(data: Partial<NewBangumiRow>): NewBangumiRow {
  return {
    official_title: data.official_title ?? 'official_title',
    year: data.year ?? null,
    title_raw: data.title_raw ?? 'title_raw',
    season: data.season ?? 1,
    season_raw: data.season_raw ?? null,
    group_name: data.group_name ?? null,
    dpi: data.dpi ?? null,
    source: data.source ?? null,
    subtitle: data.subtitle ?? null,
    eps_collect: data.eps_collect ?? false,
    episode_offset: data.episode_offset ?? 0,
    season_offset: data.season_offset ?? 0,
    filter: data.filter ?? '720,\\d+-\\d+',
    rss_link: data.rss_link ?? '',
    poster_link: data.poster_link ?? null,
    added: data.added ?? false,
    rule_name: data.rule_name ?? null,
    save_path: data.save_path ?? null,
    deleted: data.deleted ?? false,
    archived: data.archived ?? false,
    air_weekday: data.air_weekday ?? null,
    weekday_locked: data.weekday_locked ?? false,
    needs_review: data.needs_review ?? false,
    needs_review_reason: data.needs_review_reason ?? null,
    suggested_season_offset: data.suggested_season_offset ?? null,
    suggested_episode_offset: data.suggested_episode_offset ?? null,
    title_aliases: data.title_aliases ?? null,
    preferred_group: data.preferred_group ?? null,
    preferred_resolution: data.preferred_resolution ?? null,
    episode_type: data.episode_type ?? 'episode',
    ...(data.id !== undefined ? { id: data.id } : {}),
  };
}
export type NewBangumi = typeof bangumi.$inferInsert;

// ---------------------------------------------------------------------------
// Matching helpers (module-level functions in Python)
// ---------------------------------------------------------------------------

/** Normalize group name for comparison by removing common separators. */
export function normalizeGroupName(group: string | null | undefined): string {
  if (!group) return '';
  return group.replace(/[&×_\-]/g, '').toLowerCase().trim();
}

/**
 * Check if two group names are similar enough to be considered the same group.
 * Handles "LoliHouse" vs "LoliHouse&动漫国字幕组", "字幕组A" vs "字幕组A×字幕组B".
 */
export function groupsAreSimilar(
  group1: string | null | undefined,
  group2: string | null | undefined,
): boolean {
  if (!group1 || !group2) return false;
  if (group1 === group2 || group1.includes(group2) || group2.includes(group1)) {
    return true;
  }
  const norm1 = normalizeGroupName(group1);
  const norm2 = normalizeGroupName(group2);
  return norm1.includes(norm2) || norm2.includes(norm1);
}

/** Get the list of title aliases from a bangumi's title_aliases JSON field. */
export function getAliasesList(b: BangumiRow): string[] {
  if (!b.title_aliases) return [];
  try {
    const aliases = JSON.parse(b.title_aliases) as unknown;
    if (!Array.isArray(aliases)) return [];
    return aliases.filter((a): a is string => Boolean(a));
  } catch {
    return [];
  }
}

/** Set the title aliases JSON field from a list (dedup, order-preserving). */
export function setAliasesList(b: BangumiRow, aliases: string[]): void {
  if (!aliases.length) {
    b.title_aliases = null;
  } else {
    b.title_aliases = JSON.stringify([...new Set(aliases)]);
  }
}

/** All title patterns for matching (title_raw + all aliases). */
export function allTitlePatterns(b: BangumiRow): string[] {
  const patterns: string[] = [];
  if (b.title_raw) patterns.push(b.title_raw);
  patterns.push(...getAliasesList(b));
  return patterns;
}

/** Normalize a save_path so equivalent paths compare equal. */
export function normalizeSavePath(savePath: string | null | undefined): string {
  if (!savePath) return '';
  return savePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Build an in-memory normalized-save_path -> Bangumi index. */
export function buildSavePathIndex(bangumiList: BangumiRow[]): Map<string, BangumiRow> {
  const index = new Map<string, BangumiRow>();
  for (const b of bangumiList) {
    if (b.deleted || !b.save_path) continue;
    const key = normalizeSavePath(b.save_path);
    if (key && !index.has(key)) index.set(key, b);
  }
  return index;
}

/** 在已加载的候选列表中查找语义重复项（同一部番剧、命名规则不同）。 */
function findSemanticMatch(
  data: Pick<
    BangumiRow,
    'title_raw' | 'group_name' | 'season' | 'episode_type' | 'dpi' | 'subtitle' | 'source'
  >,
  candidates: BangumiRow[],
): BangumiRow | undefined {
  for (const candidate of candidates) {
    const isExactDuplicate =
      candidate.title_raw === data.title_raw &&
      candidate.group_name === data.group_name &&
      candidate.season === data.season &&
      candidate.episode_type === data.episode_type;
    if (isExactDuplicate) continue;

    // Python 的 Bangumi(**payload) 会把缺失的 Optional 字段物化为 None——
    // 双侧 ?? null 归一，避免 API 省略键（undefined）与 DB 的 null 严格不等
    const isSemanticMatch =
      candidate.season === data.season &&
      candidate.episode_type === data.episode_type &&
      (candidate.dpi ?? null) === (data.dpi ?? null) &&
      (candidate.subtitle ?? null) === (data.subtitle ?? null) &&
      (candidate.source ?? null) === (data.source ?? null) &&
      groupsAreSimilar(candidate.group_name, data.group_name);
    if (isSemanticMatch) return candidate;
  }
  return undefined;
}

/**
 * 新条目缺年份时继承同名已有条目的年份（save path 由 official_title (year)
 * 组成，年份不一致会被拆进两个媒体库目录）。
 */
function inheritYear(data: NewBangumi, candidates: BangumiRow[]): void {
  if (data.year) return;
  for (const candidate of candidates) {
    if (candidate.year) {
      data.year = candidate.year;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Release <-> bangumi matching
// ---------------------------------------------------------------------------

function releaseMatchesBangumi(release: ParsedRelease | null, b: BangumiRow): boolean {
  if (release === null) return true;
  if (release.is_mixed_collection) return false;

  if (
    release.media_type === MediaType.PV ||
    release.media_type === MediaType.OPENING ||
    release.media_type === MediaType.ENDING
  ) {
    return false;
  }
  let expectedType: string;
  if (release.media_type === MediaType.MOVIE) {
    expectedType = 'movie';
  } else if (
    release.media_type === MediaType.OVA ||
    release.media_type === MediaType.OAD ||
    release.media_type === MediaType.SPECIAL
  ) {
    expectedType = 'special';
  } else {
    expectedType = 'episode';
  }
  if (b.episode_type !== expectedType) return false;
  if (expectedType === 'special') return b.season === 0;
  return release.season === null || b.season === release.season;
}

/**
 * Match a torrent name against an already-loaded list of bangumi.
 * Pure/in-memory: the RSS refresh cycle loads the active bangumi once and
 * matches every torrent against it here. Returns the bangumi with the longest
 * matching pattern for specificity.
 */
export function matchBangumiInList(
  torrentName: string,
  bangumiList: BangumiRow[],
): BangumiRow | undefined {
  // Lazy require avoids the database -> parser -> database import cycle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseConfiguredReleaseTitleOutcome } = require('../../parser/selector') as typeof import('../../parser/selector');

  const parseOutcome = parseConfiguredReleaseTitleOutcome(torrentName);
  const release = parseOutcome.result;
  if (parseOutcome.engine === 'tokenizer') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { persistenceTarget, PersistenceTarget } = require('../../parser/release-policy') as typeof import('../../parser/release-policy');
    if (release === null || persistenceTarget(release) !== PersistenceTarget.BANGUMI) {
      return undefined;
    }
  }
  // title_raw 由解析器重组，未必是种子名的子串（#1103、#1114）；
  // 与本种子重组出的标题完全相等也算命中。
  const releaseTitle = release && (release.title_en || release.title_zh || release.title_jp);
  let bestMatch: BangumiRow | undefined;
  let bestRank: [number, number, number] = [-1, -1, -1];
  for (const b of bangumiList) {
    if (b.deleted || !releaseMatchesBangumi(release, b)) continue;
    for (const pattern of allTitlePatterns(b)) {
      if (!torrentName.includes(pattern) && pattern !== releaseTitle) continue;
      const groupMatch =
        release !== null && groupsAreSimilar(release.group, b.group_name) ? 1 : 0;
      const rank: [number, number, number] = [pattern.length, groupMatch, b.season];
      if (rank[0] > bestRank[0] ||
        (rank[0] === bestRank[0] && rank[1] > bestRank[1]) ||
        (rank[0] === bestRank[0] && rank[1] === bestRank[1] && rank[2] > bestRank[2])) {
        bestMatch = b;
        bestRank = rank;
      }
    }
  }
  return bestMatch;
}

/**
 * 种子的季度/类型与番剧不冲突。整订阅下载（subscribe/collect）不做标题
 * 匹配，搜索类 RSS 会混入其他季，需用此过滤（#1105）。
 */
export function releaseFitsBangumi(torrentName: string, b: BangumiRow): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseConfiguredReleaseTitle } = require('../../parser/selector') as typeof import('../../parser/selector');
  return releaseMatchesBangumi(parseConfiguredReleaseTitle(torrentName), b);
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class BangumiDatabase {
  private get db() {
    return getDb();
  }

  /** 加载与给定 official_title 同名的所有未删除条目。 */
  private sameTitleCandidates(officialTitle: string): BangumiRow[] {
    return this.db
      .select()
      .from(bangumi)
      .where(and(eq(bangumi.official_title, officialTitle), eq(bangumi.deleted, false)))
      .all();
  }

  /** Find existing bangumi that semantically matches the new one. */
  findSemanticDuplicate(data: NewBangumi): BangumiRow | undefined {
    const candidates = this.sameTitleCandidates(data.official_title);
    const match = findSemanticMatch(data as BangumiRow, candidates);
    if (match) {
      logger.debug(
        `Found semantic duplicate: '${data.title_raw}' matches existing ` +
          `'${match.title_raw}' (official: ${data.official_title})`,
      );
    }
    return match;
  }

  /** Add a new title_raw alias to an existing bangumi. */
  addTitleAlias(bangumiId: number, newTitleRaw: string | null | undefined): boolean {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, bangumiId)).get();
    if (!b) {
      logger.warn(`Cannot add alias: bangumi id ${bangumiId} not found`);
      return false;
    }
    if (!newTitleRaw) return false;
    if (b.title_raw === newTitleRaw) return false;
    const aliases = getAliasesList(b);
    if (aliases.includes(newTitleRaw)) return false;
    aliases.push(newTitleRaw);
    setAliasesList(b, aliases);
    this.db
      .update(bangumi)
      .set({ title_aliases: b.title_aliases })
      .where(eq(bangumi.id, bangumiId))
      .run();
    logger.log(
      `Added alias '${newTitleRaw}' to bangumi '${b.official_title}' (id: ${bangumiId})`,
    );
    return true;
  }

  getAllTitlePatterns(b: BangumiRow): string[] {
    return allTitlePatterns(b);
  }

  /** Find an existing rule with the same typed subscription identity. */
  findDuplicate(data: NewBangumi): BangumiRow | undefined {
    const rows = this.db
      .select()
      .from(bangumi)
      .where(
        and(
          eq(bangumi.title_raw, data.title_raw),
          data.group_name === null || data.group_name === undefined
            ? sql`${bangumi.group_name} IS NULL`
            : eq(bangumi.group_name, data.group_name),
          eq(bangumi.season, data.season),
          eq(bangumi.episode_type, data.episode_type ?? 'episode'),
        ),
      )
      .orderBy(asc(bangumi.id))
      .all();
    if (rows.length > 1) {
      logger.warn(
        `Multiple bangumi rows share (title_raw=${data.title_raw}, ` +
          `group_name=${data.group_name}, season=${data.season}, ` +
          `episode_type=${data.episode_type}); using the oldest (id=${rows[0].id})`,
      );
    }
    return rows[0];
  }

  private isDuplicate(data: NewBangumi): boolean {
    return this.findDuplicate(data) !== undefined;
  }

  add(data: NewBangumi): boolean {
    // Python 语义：Bangumi 模型实例在构造时已带默认值（season=1 等）——
    // 去重比较也在这些默认值上进行，先补齐再判重
    data = withBangumiDefaults(data);
    if (this.isDuplicate(data)) {
      logger.debug(`Skipping duplicate: ${data.official_title} (${data.group_name})`);
      return false;
    }

    // Check for semantic duplicate (same anime, different naming pattern)
    const candidates = this.sameTitleCandidates(data.official_title);
    const semanticMatch = findSemanticMatch(data as BangumiRow, candidates);
    if (semanticMatch) {
      // Add as alias instead of creating new entry
      this.addTitleAlias(semanticMatch.id, data.title_raw);
      logger.log(
        `Merged '${data.title_raw}' as alias to existing '${semanticMatch.title_raw}' ` +
          `(official: ${data.official_title})`,
      );
      return false;
    }

    inheritYear(data, candidates);
    // Python 语义：ORM flush 后自增 id 回填到 data.id——collector 的新插入
    // 分支依赖它（ab:<id> 标签、种子行关联、markEpsCollect、失败回滚删除）
    const result = this.db.insert(bangumi).values(data).run();
    (data as { id?: number }).id = Number(result.lastInsertRowid);
    logger.debug(`Insert ${data.official_title} into database.`);
    return true;
  }

  /** Add multiple bangumi, skipping duplicates. Returns count of added items. */
  addAll(datas: NewBangumi[]): number {
    if (!datas.length) return 0;
    // 同 add()：先补默认值再判重
    datas = datas.map((d) => withBangumiDefaults(d));

    // Batch query: load all existing typed subscription identities at once.
    const keyOf = (d: { title_raw: string; group_name?: string | null; season: number; episode_type?: string | null }) =>
      `${d.title_raw}${d.group_name ?? ''}${d.season}${d.episode_type ?? 'episode'}`;
    const conditions = datas.map((d) =>
      and(
        eq(bangumi.title_raw, d.title_raw),
        d.group_name === null || d.group_name === undefined
          ? sql`${bangumi.group_name} IS NULL`
          : eq(bangumi.group_name, d.group_name),
        eq(bangumi.season, d.season),
        eq(bangumi.episode_type, d.episode_type ?? 'episode'),
      ),
    );
    const existingRows = this.db
      .select({
        title_raw: bangumi.title_raw,
        group_name: bangumi.group_name,
        season: bangumi.season,
        episode_type: bangumi.episode_type,
      })
      .from(bangumi)
      .where(or(...conditions))
      .all();
    const existing = new Set(existingRows.map((r) => keyOf(r)));

    // Filter out exact duplicates
    const toAdd = datas.filter((d) => !existing.has(keyOf(d)));

    // Batch query: load all semantic-duplicate candidates (grouped by
    // official_title) in one SELECT.
    const officialTitles = [...new Set(toAdd.map((d) => d.official_title))];
    const candidatesByTitle = new Map<string, BangumiRow[]>();
    if (officialTitles.length) {
      const rows = this.db
        .select()
        .from(bangumi)
        .where(and(inArray(bangumi.official_title, officialTitles), eq(bangumi.deleted, false)))
        .all();
      for (const candidate of rows) {
        const list = candidatesByTitle.get(candidate.official_title) ?? [];
        list.push(candidate);
        candidatesByTitle.set(candidate.official_title, list);
      }
    }

    // Check for semantic duplicates and add as aliases
    let semanticMerged = 0;
    const reallyToAdd: NewBangumi[] = [];
    for (const d of toAdd) {
      const semanticMatch = findSemanticMatch(
        d as BangumiRow,
        candidatesByTitle.get(d.official_title) ?? [],
      );
      if (semanticMatch) {
        this.addTitleAlias(semanticMatch.id, d.title_raw);
        semanticMerged += 1;
        logger.log(
          `Merged '${d.title_raw}' as alias to existing '${semanticMatch.title_raw}' ` +
            `(official: ${d.official_title})`,
        );
      } else {
        inheritYear(d, candidatesByTitle.get(d.official_title) ?? []);
        reallyToAdd.push(d);
      }
    }

    // Also deduplicate within the batch itself
    const seen = new Set<string>();
    const uniqueToAdd: NewBangumi[] = [];
    for (const d of reallyToAdd) {
      const key = keyOf(d);
      if (!seen.has(key)) {
        seen.add(key);
        uniqueToAdd.push(d);
      }
    }

    if (!uniqueToAdd.length) {
      if (semanticMerged > 0) {
        logger.debug(`${semanticMerged} bangumi merged as aliases, rest were duplicates.`);
      } else {
        logger.debug(`All ${datas.length} bangumi already exist, skipping.`);
      }
      return 0;
    }

    this.db.insert(bangumi).values(uniqueToAdd).run();
    const skipped = datas.length - uniqueToAdd.length - semanticMerged;
    if (skipped > 0 || semanticMerged > 0) {
      logger.debug(
        `Insert ${uniqueToAdd.length} bangumi, skipped ${skipped} duplicates, ` +
          `merged ${semanticMerged} as aliases.`,
      );
    } else {
      logger.debug(`Insert ${uniqueToAdd.length} bangumi into database.`);
    }
    return uniqueToAdd.length;
  }

  update(data: Partial<BangumiRow> & { id: number }): boolean {
    const existing = this.db.select().from(bangumi).where(eq(bangumi.id, data.id)).get();
    if (!existing) return false;
    const { id, ...fields } = data;
    this.db.update(bangumi).set(fields).where(eq(bangumi.id, id)).run();
    logger.debug(`Update ${data.official_title ?? id}`);
    return true;
  }

  updateAll(datas: BangumiRow[]): void {
    for (const d of datas) {
      const { id, ...fields } = d;
      this.db.update(bangumi).set(fields).where(eq(bangumi.id, id)).run();
    }
    logger.debug(`Update ${datas.length} bangumi.`);
  }

  updateRss(titleRaw: string, rssSet: string): void {
    // Python scalar_one_or_none：多行命中直接抛错（遗留脏数据不静默）
    const rows = this.db.select().from(bangumi).where(eq(bangumi.title_raw, titleRaw)).all();
    if (rows.length > 1) throw new Error(`MultipleResultsFound for title_raw=${titleRaw}`);
    const b = rows[0];
    if (b) {
      this.db
        .update(bangumi)
        .set({ rss_link: rssSet, added: false })
        .where(eq(bangumi.id, b.id))
        .run();
      logger.debug(`Update ${titleRaw} rss_link to ${rssSet}.`);
    }
  }

  updatePoster(titleRaw: string, posterLink: string): void {
    const rows = this.db.select().from(bangumi).where(eq(bangumi.title_raw, titleRaw)).all();
    if (rows.length > 1) throw new Error(`MultipleResultsFound for title_raw=${titleRaw}`);
    const b = rows[0];
    if (b) {
      this.db.update(bangumi).set({ poster_link: posterLink }).where(eq(bangumi.id, b.id)).run();
      logger.debug(`Update ${titleRaw} poster_link to ${posterLink}.`);
    }
  }

  /** 取消软删除（重新启用规则）。行不存在或本就未删除时不写库。 */
  restoreOne(id: number): boolean {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (!b || !b.deleted) return false;
    this.db.update(bangumi).set({ deleted: false }).where(eq(bangumi.id, id)).run();
    logger.log(`Restored disabled bangumi id: ${id}.`);
    return true;
  }

  /** 只把 eps_collect 置位，不触碰行内其他字段。 */
  markEpsCollect(id: number): void {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (b) {
      this.db.update(bangumi).set({ eps_collect: true }).where(eq(bangumi.id, id)).run();
    }
  }

  deleteOne(id: number): void {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (b) {
      this.db.delete(bangumi).where(eq(bangumi.id, id)).run();
      logger.debug(`Delete bangumi id: ${id}.`);
    }
  }

  deleteAll(): void {
    // torrent / aria2_gid 行经外键引用 bangumi.id，必须先清理引用；
    // 种子记录随规则一起删，aria2 映射行保留但解除关联。
    // Python：session 内一次 commit；这里包事务保证整体原子性
    getSqlite().transaction(() => {
      this.db.delete(torrent).where(sql`${torrent.bangumi_id} IS NOT NULL`).run();
      this.db
        .update(aria2Gid)
        .set({ bangumi_id: null })
        .where(sql`${aria2Gid.bangumi_id} IS NOT NULL`)
        .run();
      this.db.delete(bangumi).run();
    })();
  }

  searchAll(): BangumiRow[] {
    return this.db.select().from(bangumi).all();
  }

  searchId(id: number): BangumiRow | undefined {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (b === undefined) {
      logger.warn(`Cannot find bangumi id: ${id}.`);
      return undefined;
    }
    logger.debug(`Find bangumi id: ${id}.`);
    return b;
  }

  searchOfficialTitle(officialTitle: string): BangumiRow | undefined {
    return this.db
      .select()
      .from(bangumi)
      .where(eq(bangumi.official_title, officialTitle))
      .orderBy(asc(bangumi.episode_type), asc(bangumi.season), asc(bangumi.id))
      .get();
  }

  searchIds(ids: number[]): BangumiRow[] {
    if (!ids.length) return [];
    return this.db.select().from(bangumi).where(inArray(bangumi.id, ids)).all();
  }

  matchPoster(bangumiName: string): string {
    const rows = this.db
      .select()
      .from(bangumi)
      .where(sql`instr(${bangumiName}, ${bangumi.official_title}) > 0`)
      .all();
    if (rows.length > 1) throw new Error(`MultipleResultsFound for matchPoster`);
    return rows[0]?.poster_link ?? '';
  }

  matchList<T extends { name: string }>(
    torrentList: T[],
    rssLink: string,
    matcher: (torrentName: string, bangumiList: BangumiRow[]) => BangumiRow | undefined = matchBangumiInList,
  ): T[] {
    const matchDatas = this.searchAll();
    if (!matchDatas.length) return torrentList;

    const unmatched: T[] = [];
    const rssUpdated = new Set<string>();
    for (const t of torrentList) {
      const matchData = matcher(t.name, matchDatas);
      if (matchData !== undefined) {
        const matchKey = String(matchData.id ?? `${matchData.title_raw}|${matchData.season}|${matchData.episode_type}`);
        if (!matchData.rss_link.includes(rssLink) && !rssUpdated.has(matchKey)) {
          this.db
            .update(bangumi)
            .set({ rss_link: `${matchData.rss_link},${rssLink}`, added: false })
            .where(eq(bangumi.id, matchData.id))
            .run();
          matchData.rss_link = `${matchData.rss_link},${rssLink}`;
          matchData.added = false;
          rssUpdated.add(matchKey);
        }
      } else {
        unmatched.push(t);
      }
    }
    if (rssUpdated.size) {
      logger.debug(`Batch updated rss_link for ${rssUpdated.size} bangumi.`);
    }
    return unmatched;
  }

  /** Match torrent name to a bangumi (title_raw + title_aliases). */
  matchTorrent(torrentName: string): BangumiRow | undefined {
    return matchBangumiInList(torrentName, this.searchAll());
  }

  notComplete(): BangumiRow[] {
    return this.db
      .select()
      .from(bangumi)
      .where(and(eq(bangumi.eps_collect, false), eq(bangumi.deleted, false)))
      .all();
  }

  notAdded(): BangumiRow[] {
    return this.db
      .select()
      .from(bangumi)
      .where(
        or(
          eq(bangumi.added, false),
          sql`${bangumi.rule_name} IS NULL`,
          sql`${bangumi.save_path} IS NULL`,
        ),
      )
      .all();
  }

  disableRule(id: number): void {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (b) {
      this.db.update(bangumi).set({ deleted: true }).where(eq(bangumi.id, id)).run();
      logger.debug(`Disable rule ${b.title_raw}.`);
    }
  }

  searchRss(rssLink: string): BangumiRow[] {
    return this.db
      .select()
      .from(bangumi)
      .where(sql`instr(${rssLink}, ${bangumi.rss_link}) > 0`)
      .all();
  }

  archiveOne(id: number): boolean {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (!b) {
      logger.warn(`Cannot archive bangumi id: ${id}, not found.`);
      return false;
    }
    this.db.update(bangumi).set({ archived: true }).where(eq(bangumi.id, id)).run();
    logger.debug(`Archived bangumi id: ${id}.`);
    return true;
  }

  unarchiveOne(id: number): boolean {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (!b) {
      logger.warn(`Cannot unarchive bangumi id: ${id}, not found.`);
      return false;
    }
    this.db.update(bangumi).set({ archived: false }).where(eq(bangumi.id, id)).run();
    logger.debug(`Unarchived bangumi id: ${id}.`);
    return true;
  }

  /** Find bangumi by save_path (exact match first, then separator variations). */
  matchBySavePath(savePath: string): BangumiRow | undefined {
    if (!savePath) return undefined;

    const exact = this.db
      .select()
      .from(bangumi)
      .where(and(eq(bangumi.save_path, savePath), eq(bangumi.deleted, false)))
      .get();
    if (exact) return exact;

    const normalized = savePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const variations = [
      normalized,
      normalized + '/',
      savePath.replace(/\/+$/, ''),
      savePath.replace(/\\+$/, ''),
    ];
    const seen = new Set([savePath]);
    for (const variant of variations) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      const found = this.db
        .select()
        .from(bangumi)
        .where(and(eq(bangumi.save_path, variant), eq(bangumi.deleted, false)))
        .get();
      if (found) return found;
    }
    return undefined;
  }

  getNeedsReview(): BangumiRow[] {
    return this.db
      .select()
      .from(bangumi)
      .where(and(eq(bangumi.needs_review, true), eq(bangumi.deleted, false)))
      .all();
  }

  /** Get all active (non-deleted, non-archived) bangumi for offset scanning. */
  getActiveForScan(): BangumiRow[] {
    return this.db
      .select()
      .from(bangumi)
      .where(and(eq(bangumi.deleted, false), eq(bangumi.archived, false)))
      .all();
  }

  setNeedsReview(
    id: number,
    reason: string,
    suggestedSeasonOffset: number | null = null,
    suggestedEpisodeOffset: number | null = null,
  ): boolean {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (!b) return false;
    this.db
      .update(bangumi)
      .set({
        needs_review: true,
        needs_review_reason: reason,
        suggested_season_offset: suggestedSeasonOffset,
        suggested_episode_offset: suggestedEpisodeOffset,
      })
      .where(eq(bangumi.id, id))
      .run();
    logger.debug(
      `Marked bangumi id ${id} as needs_review: ${reason} ` +
        `(suggested: season=${suggestedSeasonOffset}, episode=${suggestedEpisodeOffset})`,
    );
    return true;
  }

  /** 将建议的季度/集数偏移写入正式偏移，并清除检查标记。 */
  applyOffset(id: number): boolean {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (!b) return false;
    const seasonOffset = b.suggested_season_offset ?? b.season_offset;
    const episodeOffset = b.suggested_episode_offset ?? b.episode_offset;
    this.db
      .update(bangumi)
      .set({
        season_offset: seasonOffset,
        episode_offset: episodeOffset,
        needs_review: false,
        needs_review_reason: null,
        suggested_season_offset: null,
        suggested_episode_offset: null,
      })
      .where(eq(bangumi.id, id))
      .run();
    logger.debug(
      `Applied offset for bangumi id ${id}: season=${seasonOffset}, episode=${episodeOffset}`,
    );
    return true;
  }

  clearNeedsReview(id: number): boolean {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (!b) return false;
    this.db
      .update(bangumi)
      .set({
        needs_review: false,
        needs_review_reason: null,
        suggested_season_offset: null,
        suggested_episode_offset: null,
      })
      .where(eq(bangumi.id, id))
      .run();
    logger.debug(`Cleared needs_review for bangumi id ${id}`);
    return true;
  }

  /** Set air_weekday and weekday_locked for manual calendar assignment. */
  setWeekday(id: number, weekday: number | null): boolean {
    const b = this.db.select().from(bangumi).where(eq(bangumi.id, id)).get();
    if (!b) return false;
    this.db
      .update(bangumi)
      .set(
        weekday !== null
          ? { air_weekday: weekday, weekday_locked: true }
          : { air_weekday: null, weekday_locked: false },
      )
      .where(eq(bangumi.id, id))
      .run();
    logger.debug(`Set weekday=${weekday}, locked=${weekday !== null} for bangumi id ${id}`);
    return true;
  }
}
