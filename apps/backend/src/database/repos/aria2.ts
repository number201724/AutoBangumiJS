/**
 * aria2 gid association repository — 1:1 port of module/database/aria2.py.
 *
 * aria2 has no tag/category concept; this table persists
 * gid -> bangumi_id / category / dedup_key / renamed_paths / rename_intent.
 */
import { eq, inArray } from 'drizzle-orm';
import { Logger } from '@nestjs/common';

import { getDb } from '../database';
import { aria2Gid } from '../schema';
import { utcNow } from '../../utils/time';

const logger = new Logger('Aria2GidDatabase');

export type Aria2GidRow = typeof aria2Gid.$inferSelect;

/** Durable proof that this gid owned a filesystem move before it started.
 * stat 字段（st_dev/st_ino/st_size/st_mtime_ns）在 JSON 里按**字符串**存储：
 * mtime_ns ≈ 1.7e18 超过 2^53，JS number/double 会丢精度（Python json 是
 * 任意精度 int64）。比较时经 BigInt 转换。
 * 注意：Python 端 from_json 要求 stat 字段是 int——读到字符串会判定为无效
 * intent（降级为"无 intent"，不影响正确性，只少一次恢复）。 */
export interface Aria2RenameIntent {
  old_path: string;
  new_path: string;
  st_dev: string;
  st_ino: string;
  st_size: string;
  st_mtime_ns: string;
}

export function renameIntentToJson(intent: Aria2RenameIntent): string {
  const ordered: Record<string, unknown> = { version: 1, ...intent };
  return JSON.stringify(
    Object.keys(ordered)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => ((acc[k] = ordered[k]), acc), {}),
  );
}

export function renameIntentFromJson(raw: string | null | undefined): Aria2RenameIntent | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.version !== 1) return null;
  for (const field of ['old_path', 'new_path'] as const) {
    if (typeof d[field] !== 'string') return null;
  }
  // stat 字段：字符串（本实现写入的形态）或整数（Python 端写入的形态）都接受，
  // 统一转成字符串；整数超过 2^53 时 JSON.parse 已丢精度——跨实现读取的固有
  // 限制，与本实现自写自读路径无关。
  const statFields: Record<string, string> = {};
  for (const field of ['st_dev', 'st_ino', 'st_size', 'st_mtime_ns'] as const) {
    const v = d[field];
    if (typeof v === 'string' && /^-?\d+$/.test(v)) {
      statFields[field] = v;
    } else if (typeof v === 'number' && Number.isInteger(v)) {
      statFields[field] = String(v);
    } else {
      return null;
    }
  }
  return {
    old_path: d.old_path as string,
    new_path: d.new_path as string,
    st_dev: statFields.st_dev,
    st_ino: statFields.st_ino,
    st_size: statFields.st_size,
    st_mtime_ns: statFields.st_mtime_ns,
  };
}

function decodeRenamedPaths(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function mergeRenamedPaths(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  const merged = decodeRenamedPaths(left);
  const incoming = decodeRenamedPaths(right);
  return JSON.stringify({ ...merged, ...incoming });
}

export class Aria2GidDatabase {
  private get db() {
    return getDb();
  }

  /** 新增一条 gid 记录，或者用非空字段覆盖已有记录。 */
  upsert(
    gid: string,
    fields: {
      bangumi_id?: number | null;
      category?: string | null;
      dedup_key?: string | null;
      renamed_paths?: string | null;
    } = {},
  ): void {
    const existing = this.db.select().from(aria2Gid).where(eq(aria2Gid.gid, gid)).get();
    if (!existing) {
      this.db
        .insert(aria2Gid)
        .values({
          gid,
          bangumi_id: fields.bangumi_id ?? null,
          category: fields.category ?? null,
          dedup_key: fields.dedup_key ?? null,
          renamed_paths: fields.renamed_paths ?? null,
          created_at: utcNow(),
        })
        .run();
    } else {
      const set: Record<string, unknown> = {};
      if (fields.bangumi_id !== null && fields.bangumi_id !== undefined)
        set.bangumi_id = fields.bangumi_id;
      if (fields.category !== null && fields.category !== undefined)
        set.category = fields.category;
      if (fields.dedup_key !== null && fields.dedup_key !== undefined)
        set.dedup_key = fields.dedup_key;
      if (fields.renamed_paths !== null && fields.renamed_paths !== undefined)
        set.renamed_paths = fields.renamed_paths;
      if (Object.keys(set).length) {
        this.db.update(aria2Gid).set(set).where(eq(aria2Gid.gid, gid)).run();
      }
    }
  }

  get(gid: string): Aria2GidRow | undefined {
    return this.db.select().from(aria2Gid).where(eq(aria2Gid.gid, gid)).get();
  }

  getMany(gids: string[]): Map<string, Aria2GidRow> {
    const map = new Map<string, Aria2GidRow>();
    if (!gids.length) return map;
    for (const row of this.db.select().from(aria2Gid).where(inArray(aria2Gid.gid, gids)).all()) {
      map.set(row.gid, row);
    }
    return map;
  }

  /** 返回携带该 dedup_key 的已有 gid（没有则 undefined），用于新增前判重。 */
  findByDedupKey(dedupKey: string): string | undefined {
    const row = this.db
      .select({ gid: aria2Gid.gid })
      .from(aria2Gid)
      .where(eq(aria2Gid.dedup_key, dedupKey))
      .get();
    return row?.gid;
  }

  setCategory(gid: string, category: string): void {
    this.upsert(gid, { category });
  }

  /** Move local metadata from an aria2 metadata gid to its followedBy gid. */
  replaceGid(oldGid: string, newGid: string): void {
    if (oldGid === newGid) return;
    const old = this.get(oldGid);
    if (!old) return;
    const existing = this.get(newGid);
    if (!existing) {
      this.db
        .insert(aria2Gid)
        .values({
          gid: newGid,
          bangumi_id: old.bangumi_id,
          category: old.category,
          dedup_key: old.dedup_key,
          renamed_paths: old.renamed_paths,
          rename_intent: old.rename_intent,
          created_at: old.created_at,
        })
        .run();
    } else {
      this.db
        .update(aria2Gid)
        .set({
          bangumi_id: existing.bangumi_id ?? old.bangumi_id,
          category: existing.category ?? old.category,
          dedup_key: existing.dedup_key ?? old.dedup_key,
          renamed_paths: mergeRenamedPaths(existing.renamed_paths, old.renamed_paths),
          rename_intent: existing.rename_intent ?? old.rename_intent,
        })
        .where(eq(aria2Gid.gid, newGid))
        .run();
    }
    this.db.delete(aria2Gid).where(eq(aria2Gid.gid, oldGid)).run();
  }

  getRenamedPaths(gid: string): Record<string, string> {
    const record = this.get(gid);
    if (!record || !record.renamed_paths) return {};
    try {
      return decodeRenamedPaths(record.renamed_paths);
    } catch {
      logger.warn(`Ignoring invalid renamed_paths for gid ${gid}`);
      return {};
    }
  }

  setRenamedPath(gid: string, oldPath: string, newPath: string): void {
    const mapping = this.getRenamedPaths(gid);
    for (const [originalPath, renamedPath] of Object.entries(mapping)) {
      if (renamedPath === oldPath) mapping[originalPath] = newPath;
    }
    mapping[oldPath] = newPath;
    this.upsert(gid, { renamed_paths: JSON.stringify(mapping) });
  }

  getRenameIntent(gid: string): Aria2RenameIntent | null {
    const record = this.get(gid);
    if (!record || !record.rename_intent) return null;
    const intent = renameIntentFromJson(record.rename_intent);
    if (intent === null) {
      logger.warn(`Ignoring invalid rename_intent for gid ${gid}`);
    }
    return intent;
  }

  setRenameIntent(gid: string, intent: Aria2RenameIntent): void {
    const record = this.get(gid);
    const json = renameIntentToJson(intent);
    if (!record) {
      this.db
        .insert(aria2Gid)
        .values({ gid, rename_intent: json, created_at: utcNow() })
        .run();
    } else {
      this.db.update(aria2Gid).set({ rename_intent: json }).where(eq(aria2Gid.gid, gid)).run();
    }
  }

  clearRenameIntent(gid: string, expected?: Aria2RenameIntent): boolean {
    const record = this.get(gid);
    if (!record) return false;
    if (
      expected !== undefined &&
      JSON.stringify(renameIntentFromJson(record.rename_intent)) !== JSON.stringify(expected)
    ) {
      return false;
    }
    this.db.update(aria2Gid).set({ rename_intent: null }).where(eq(aria2Gid.gid, gid)).run();
    return true;
  }

  /** Commit the sidecar mapping and clear its matching intent together. */
  finalizeRenameIntent(gid: string, expected: Aria2RenameIntent): boolean {
    const record = this.get(gid);
    if (
      !record ||
      JSON.stringify(renameIntentFromJson(record.rename_intent)) !== JSON.stringify(expected)
    ) {
      return false;
    }
    const mapping = decodeRenamedPaths(record.renamed_paths);
    for (const [originalPath, renamedPath] of Object.entries(mapping)) {
      if (renamedPath === expected.old_path) mapping[originalPath] = expected.new_path;
    }
    mapping[expected.old_path] = expected.new_path;
    this.db
      .update(aria2Gid)
      .set({ renamed_paths: JSON.stringify(mapping), rename_intent: null })
      .where(eq(aria2Gid.gid, gid))
      .run();
    return true;
  }

  delete(gid: string): void {
    const existing = this.get(gid);
    if (existing) {
      this.db.delete(aria2Gid).where(eq(aria2Gid.gid, gid)).run();
    }
  }
}
