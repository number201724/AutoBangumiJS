/**
 * Movie repository — 1:1 port of module/database/movie.py
 * (including the 300s module-level TTL cache for search_all).
 */
import { Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { getDb } from '../database';
import { movie } from '../schema';
import { MediaType } from '../../parser/types';

const logger = new Logger('MovieDatabase');

export type MovieRow = typeof movie.$inferSelect;
export type NewMovie = typeof movie.$inferInsert;

/** 与 bangumi 同理：insert 前补齐 Python 模型的客户端默认值。 */
export function withMovieDefaults(data: Partial<NewMovie> & { official_title: string }): NewMovie {
  return {
    official_title: data.official_title,
    title_raw: data.title_raw ?? null,
    year: data.year ?? null,
    group_name: data.group_name ?? null,
    dpi: data.dpi ?? null,
    source: data.source ?? null,
    subtitle: data.subtitle ?? null,
    poster_link: data.poster_link ?? null,
    rss_link: data.rss_link ?? null,
    added: data.added ?? false,
    deleted: data.deleted ?? false,
    save_path: data.save_path ?? null,
    rule_name: data.rule_name ?? null,
    filter: data.filter ?? '',
    ...(data.id !== undefined ? { id: data.id } : {}),
  };
}

// Module-level TTL cache for searchAll results
const MOVIE_CACHE_TTL = 300.0;
let movieCache: MovieRow[] | null = null;
let movieCacheTime = 0;

export function invalidateMovieCache(): void {
  movieCache = null;
  movieCacheTime = 0;
}

export class MovieDatabase {
  private get db() {
    return getDb();
  }

  private isDuplicate(data: NewMovie): boolean {
    const titleCond =
      data.title_raw === null || data.title_raw === undefined
        ? isNull(movie.title_raw)
        : eq(movie.title_raw, data.title_raw);
    const groupCond =
      data.group_name === null || data.group_name === undefined
        ? isNull(movie.group_name)
        : eq(movie.group_name, data.group_name);
    const existing = this.db
      .select()
      .from(movie)
      .where(and(titleCond, groupCond))
      .get();
    return existing !== undefined;
  }

  add(data: NewMovie): boolean {
    if (this.isDuplicate(data)) {
      logger.debug(`Skipping duplicate movie: ${data.official_title} (${data.group_name})`);
      return false;
    }
    this.db.insert(movie).values(withMovieDefaults(data)).run();
    invalidateMovieCache();
    logger.debug(`Insert movie ${data.official_title} into database.`);
    return true;
  }

  searchAll(): MovieRow[] {
    const now = Date.now() / 1000;
    if (movieCache !== null && now - movieCacheTime < MOVIE_CACHE_TTL) {
      return movieCache;
    }
    movieCache = this.db.select().from(movie).all();
    movieCacheTime = now;
    return movieCache;
  }

  searchId(id: number): MovieRow | undefined {
    const row = this.db.select().from(movie).where(eq(movie.id, id)).get();
    if (row === undefined) {
      logger.warn(`Cannot find movie id: ${id}.`);
      return undefined;
    }
    return row;
  }

  update(data: Partial<MovieRow> & { id: number }): boolean {
    const existing = this.db.select().from(movie).where(eq(movie.id, data.id)).get();
    if (!existing) return false;
    const { id, ...fields } = data;
    this.db.update(movie).set(fields).where(eq(movie.id, id)).run();
    invalidateMovieCache();
    logger.debug(`Update movie ${data.official_title ?? id}`);
    return true;
  }

  deleteOne(id: number): void {
    const row = this.db.select().from(movie).where(eq(movie.id, id)).get();
    if (row) {
      this.db.delete(movie).where(eq(movie.id, id)).run();
      invalidateMovieCache();
      logger.debug(`Delete movie id: ${id}.`);
    }
  }

  disableRule(id: number): void {
    const row = this.db.select().from(movie).where(eq(movie.id, id)).get();
    if (row) {
      this.db.update(movie).set({ deleted: true }).where(eq(movie.id, id)).run();
      invalidateMovieCache();
      logger.debug(`Disable movie ${row.title_raw}.`);
    }
  }

  enableRule(id: number): void {
    const row = this.db.select().from(movie).where(eq(movie.id, id)).get();
    if (row) {
      this.db.update(movie).set({ deleted: false }).where(eq(movie.id, id)).run();
      invalidateMovieCache();
      logger.debug(`Enable movie ${row.title_raw}.`);
    }
  }

  matchList<T extends { name: string }>(torrentList: T[], rssLink: string): T[] {
    // Lazy require avoids a database/parser import cycle during startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseConfiguredReleaseTitle } = require('../../parser/selector') as typeof import('../../parser/selector');

    const matchDatas = this.searchAll();
    if (!matchDatas.length) return torrentList;

    const titleIndex = new Map<string, MovieRow>();
    for (const m of matchDatas) {
      if (m.title_raw) titleIndex.set(m.title_raw, m);
    }
    if (!titleIndex.size) return torrentList;

    const sortedTitles = [...titleIndex.keys()].sort((a, b) => b.length - a.length);
    const titleRegex = new RegExp(
      sortedTitles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    );

    const unmatched: T[] = [];
    const rssUpdated = new Set<string>();
    for (const t of torrentList) {
      const match = titleRegex.exec(t.name);
      const release = parseConfiguredReleaseTitle(t.name);
      if (match && release !== null && release.media_type === MediaType.MOVIE) {
        const matchData = titleIndex.get(match[0])!;
        if (
          matchData.rss_link &&
          !matchData.rss_link.includes(rssLink) &&
          !rssUpdated.has(matchData.title_raw!)
        ) {
          this.db
            .update(movie)
            .set({ rss_link: `${matchData.rss_link},${rssLink}`, added: false })
            .where(eq(movie.id, matchData.id))
            .run();
          rssUpdated.add(matchData.title_raw!);
        }
      } else {
        unmatched.push(t);
      }
    }
    if (rssUpdated.size) {
      invalidateMovieCache();
    }
    return unmatched;
  }

  notAdded(): MovieRow[] {
    return this.db.select().from(movie).where(eq(movie.added, false)).all();
  }
}
