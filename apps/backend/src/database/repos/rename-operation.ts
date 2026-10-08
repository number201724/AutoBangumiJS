/**
 * Durable rename/revision-replacement operation repository —
 * 1:1 port of module/database/rename_operation.py (#1078).
 */
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';

import { getDb } from '../database';
import {
  RENAME_OPERATION_STATES,
  renameOperation,
  type RenameOperationState,
} from '../schema';
import { utcNow } from '../../utils/time';

export type RenameOperationRow = typeof renameOperation.$inferSelect;
export type NewRenameOperation = typeof renameOperation.$inferInsert;

function validateState(state: string): void {
  if (!(RENAME_OPERATION_STATES as readonly string[]).includes(state)) {
    throw new Error(`Unsupported rename operation state: ${state}`);
  }
}

const REPLACEMENT_ACTIVE_STATES = ['planned', 'old_staged', 'new_promoted', 'old_removed'];

export class RenameOperationDatabase {
  private get db() {
    return getDb();
  }

  get(operationId: number | null | undefined): RenameOperationRow | undefined {
    if (operationId === null || operationId === undefined) return undefined;
    return this.db.select().from(renameOperation).where(eq(renameOperation.id, operationId)).get();
  }

  getByIdentity(identity: {
    downloader_type: string;
    new_task_id: string;
    save_path: string;
    source_path: string;
    target_path: string;
  }): RenameOperationRow | undefined {
    return this.db
      .select()
      .from(renameOperation)
      .where(
        and(
          eq(renameOperation.downloader_type, identity.downloader_type),
          eq(renameOperation.new_task_id, identity.new_task_id),
          eq(renameOperation.save_path, identity.save_path),
          eq(renameOperation.source_path, identity.source_path),
          eq(renameOperation.target_path, identity.target_path),
        ),
      )
      .get();
  }

  getByTarget(args: {
    downloader_type: string;
    save_path: string;
    target_path: string;
    active_only?: boolean;
  }): RenameOperationRow | undefined {
    const conditions = [
      eq(renameOperation.downloader_type, args.downloader_type),
      eq(renameOperation.save_path, args.save_path),
      eq(renameOperation.target_path, args.target_path),
    ];
    if (args.active_only ?? true) {
      conditions.push(ne(renameOperation.state, 'done'));
    }
    return this.db
      .select()
      .from(renameOperation)
      .where(and(...conditions))
      .orderBy(desc(renameOperation.updated_at))
      .get();
  }

  /**
   * Return the identity row, creating it when absent. The DB unique indexes
   * remain authoritative for concurrent writers; an identity race is re-read,
   * while an active-target collision surfaces as an error for the caller.
   */
  getOrCreate(operation: NewRenameOperation): { row: RenameOperationRow; created: boolean } {
    const identity = {
      downloader_type: operation.downloader_type,
      new_task_id: operation.new_task_id,
      save_path: operation.save_path,
      source_path: operation.source_path,
      target_path: operation.target_path,
    };
    const existing = this.getByIdentity(identity);
    if (existing !== undefined) return { row: existing, created: false };

    const now = utcNow();
    const values = {
      ...operation,
      created_at: operation.created_at || now,
      updated_at: now,
    };
    try {
      const result = this.db.insert(renameOperation).values(values).run();
      const row = this.get(Number(result.lastInsertRowid))!;
      return { row, created: true };
    } catch (e) {
      const raced = this.getByIdentity(identity);
      if (raced !== undefined) return { row: raced, created: false };
      throw e;
    }
  }

  /** Persist a terminal hold conflict without duplicating notifications. */
  upsertConflict(operation: NewRenameOperation): { row: RenameOperationRow; created: boolean } {
    operation.state = 'conflict';
    operation.retry_at = null;
    const existing = this.getByIdentity({
      downloader_type: operation.downloader_type,
      new_task_id: operation.new_task_id,
      save_path: operation.save_path,
      source_path: operation.source_path,
      target_path: operation.target_path,
    });
    if (existing === undefined) return this.getOrCreate(operation);

    // Refresh reconciliation metadata without resetting attempts,
    // notification history, or the original creation timestamp.
    const fields = {
      kind: operation.kind,
      old_task_id: operation.old_task_id,
      staged_path: operation.staged_path,
      bangumi_id: operation.bangumi_id,
      media_type: operation.media_type,
      season: operation.season,
      episode: operation.episode,
      group_name: operation.group_name,
      resolution: operation.resolution,
      old_revision: operation.old_revision,
      new_revision: operation.new_revision,
      revision_metadata: operation.revision_metadata,
      last_error: operation.last_error,
      state: 'conflict',
      retry_at: null,
      updated_at: utcNow(),
    } as const;
    this.db.update(renameOperation).set(fields).where(eq(renameOperation.id, existing.id)).run();
    return { row: this.get(existing.id)!, created: false };
  }

  setState(
    operationId: number | null | undefined,
    state: RenameOperationState,
    extra: { retry_at?: string | null; last_error?: string | null } = {},
  ): RenameOperationRow | undefined {
    validateState(state);
    const row = this.get(operationId);
    if (!row) return undefined;
    this.db
      .update(renameOperation)
      .set({
        state,
        retry_at: extra.retry_at ?? null,
        last_error: extra.last_error ?? null,
        updated_at: utcNow(),
      })
      .where(eq(renameOperation.id, row.id))
      .run();
    return this.get(row.id);
  }

  /** Atomically claim a due operation and count one execution attempt. */
  claim(
    operationId: number | null | undefined,
    fromStates: RenameOperationState[],
    toState: RenameOperationState,
  ): RenameOperationRow | undefined {
    if (operationId === null || operationId === undefined || !fromStates.length) {
      return undefined;
    }
    for (const s of fromStates) validateState(s);
    validateState(toState);
    const claimedAt = utcNow();
    const result = this.db
      .update(renameOperation)
      .set({
        state: toState,
        attempt_count: sql`${renameOperation.attempt_count} + 1`,
        retry_at: null,
        updated_at: claimedAt,
      })
      .where(
        and(
          eq(renameOperation.id, operationId),
          inArray(renameOperation.state, fromStates),
          or(isNull(renameOperation.retry_at), sql`${renameOperation.retry_at} <= ${claimedAt}`),
        ),
      )
      .run();
    if (!result.changes) return undefined;
    return this.get(operationId);
  }

  /** CAS a crashed ordinary rename lease back to retryable state. */
  recoverStaleRunning(operationId: number | null | undefined, before: string): boolean {
    if (operationId === null || operationId === undefined) return false;
    const result = this.db
      .update(renameOperation)
      .set({ state: 'retry', retry_at: null, updated_at: utcNow() })
      .where(
        and(
          eq(renameOperation.id, operationId),
          eq(renameOperation.state, 'running'),
          sql`${renameOperation.updated_at} <= ${before}`,
        ),
      )
      .run();
    return result.changes > 0;
  }

  /** Fence one replacement Saga across processes for a bounded lease. */
  claimReplacementLease(
    operationId: number | null | undefined,
    owner: string,
    leaseSeconds = 5 * 60,
  ): RenameOperationRow | undefined {
    if (operationId === null || operationId === undefined) return undefined;
    const claimedAt = utcNow();
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000);
    const expiresStr =
      `${expiresAt.getUTCFullYear()}-${String(expiresAt.getUTCMonth() + 1).padStart(2, '0')}-` +
      `${String(expiresAt.getUTCDate()).padStart(2, '0')} ${String(expiresAt.getUTCHours()).padStart(2, '0')}:` +
      `${String(expiresAt.getUTCMinutes()).padStart(2, '0')}:${String(expiresAt.getUTCSeconds()).padStart(2, '0')}.` +
      String(expiresAt.getUTCMilliseconds() * 1000).padStart(6, '0');
    const result = this.db
      .update(renameOperation)
      .set({
        lease_owner: owner,
        lease_expires_at: expiresStr,
        attempt_count: sql`${renameOperation.attempt_count} + 1`,
        updated_at: claimedAt,
      })
      .where(
        and(
          eq(renameOperation.id, operationId),
          eq(renameOperation.kind, 'replacement'),
          inArray(renameOperation.state, REPLACEMENT_ACTIVE_STATES),
          or(
            isNull(renameOperation.lease_owner),
            isNull(renameOperation.lease_expires_at),
            sql`${renameOperation.lease_expires_at} <= ${claimedAt}`,
          ),
        ),
      )
      .run();
    if (!result.changes) return undefined;
    return this.get(operationId);
  }

  /** Advance a replacement only while the caller still owns its lease. */
  setStateClaimed(
    operationId: number | null | undefined,
    owner: string,
    state: RenameOperationState,
    extra: { retry_at?: string | null; last_error?: string | null } = {},
  ): RenameOperationRow | undefined {
    if (operationId === null || operationId === undefined) return undefined;
    validateState(state);
    const now = utcNow();
    const result = this.db
      .update(renameOperation)
      .set({
        state,
        retry_at: extra.retry_at ?? null,
        last_error: extra.last_error ?? null,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: now,
      })
      .where(
        and(
          eq(renameOperation.id, operationId),
          eq(renameOperation.lease_owner, owner),
          sql`${renameOperation.lease_expires_at} > ${now}`,
        ),
      )
      .run();
    if (!result.changes) return undefined;
    return this.get(operationId);
  }

  releaseReplacementLease(operationId: number | null | undefined, owner: string): boolean {
    if (operationId === null || operationId === undefined) return false;
    const result = this.db
      .update(renameOperation)
      .set({ lease_owner: null, lease_expires_at: null, updated_at: utcNow() })
      .where(and(eq(renameOperation.id, operationId), eq(renameOperation.lease_owner, owner)))
      .run();
    return result.changes > 0;
  }

  /** Set notified_at once; concurrent or repeated calls return false. */
  markNotified(operationId: number | null | undefined): boolean {
    if (operationId === null || operationId === undefined) return false;
    const now = utcNow();
    const result = this.db
      .update(renameOperation)
      .set({ notified_at: now, updated_at: now })
      .where(and(eq(renameOperation.id, operationId), isNull(renameOperation.notified_at)))
      .run();
    return result.changes > 0;
  }

  listConflicts(limit = 100): RenameOperationRow[] {
    return this.db
      .select()
      .from(renameOperation)
      .where(eq(renameOperation.state, 'conflict'))
      .orderBy(desc(renameOperation.updated_at))
      .limit(limit)
      .all();
  }

  listRetryable(limit = 100): RenameOperationRow[] {
    const readyAt = utcNow();
    return this.db
      .select()
      .from(renameOperation)
      .where(
        and(
          eq(renameOperation.state, 'retry'),
          or(isNull(renameOperation.retry_at), sql`${renameOperation.retry_at} <= ${readyAt}`),
        ),
      )
      .orderBy(asc(renameOperation.retry_at))
      .limit(limit)
      .all();
  }

  listActiveReplacements(limit = 100): RenameOperationRow[] {
    return this.db
      .select()
      .from(renameOperation)
      .where(
        and(
          eq(renameOperation.kind, 'replacement'),
          inArray(renameOperation.state, REPLACEMENT_ACTIVE_STATES),
        ),
      )
      .orderBy(asc(renameOperation.updated_at))
      .limit(limit)
      .all();
  }

  delete(operationId: number | null | undefined): boolean {
    const row = this.get(operationId);
    if (!row) return false;
    this.db.delete(renameOperation).where(eq(renameOperation.id, row.id)).run();
    return true;
  }

  pruneDone(before: string): number {
    const result = this.db
      .delete(renameOperation)
      .where(and(eq(renameOperation.state, 'done'), lt(renameOperation.updated_at, before)))
      .run();
    return result.changes;
  }
}
