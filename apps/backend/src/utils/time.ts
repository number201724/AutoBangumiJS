/**
 * UTC time helpers matching the Python backend's storage formats.
 *
 * - TIMESTAMP columns: SQLAlchemy SQLite naive datetime storage format
 *   'YYYY-MM-DD HH:MM:SS.ffffff' (UTC values, no tz suffix).
 * - inboxmessage / rssitem timestamps: datetime.now(timezone.utc).isoformat()
 *   e.g. '2026-09-28T10:15:30.123456+00:00' (lexicographically sortable).
 */

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** 'YYYY-MM-DD HH:MM:SS.ffffff' — SQLAlchemy SQLite DATETIME storage format. */
export function utcNow(): string {
  const d = new Date();
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ` +
    `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.` +
    pad(d.getUTCMilliseconds() * 1000, 6)
  );
}

/** datetime.now(timezone.utc).isoformat() — 'YYYY-MM-DDTHH:MM:SS.ffffff+00:00'. */
export function utcNowIso(): string {
  const d = new Date();
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}T` +
    `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.` +
    pad(d.getUTCMilliseconds() * 1000, 6) +
    '+00:00'
  );
}

/** Parse a stored TIMESTAMP/ISO string into a JS Date (UTC). */
export function parseStoredTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  // 'YYYY-MM-DD HH:MM:SS.ffffff' -> ISO
  let v = value;
  if (v.includes(' ') && !v.includes('T')) v = v.replace(' ', 'T');
  if (!v.endsWith('Z') && !/[+-]\d{2}:?\d{2}$/.test(v)) v += 'Z';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Seconds from now -> stored TIMESTAMP string. */
export function utcInSeconds(seconds: number): string {
  const d = new Date(Date.now() + seconds * 1000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ` +
    `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.` +
    pad(d.getUTCMilliseconds() * 1000, 6)
  );
}

/** Convert any stored/ISO datetime to the stored TIMESTAMP format. */
export function toStoredTime(value: string | Date): string {
  const d = value instanceof Date ? value : (parseStoredTime(value) ?? new Date());
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ` +
    `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.` +
    pad(d.getUTCMilliseconds() * 1000, 6)
  );
}

/**
 * API serialization of a stored TIMESTAMP — FastAPI/pydantic renders naive
 * datetimes as 'YYYY-MM-DDTHH:MM:SS.ffffff' (no tz suffix).
 */
export function toApiIso(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return stored.includes(' ') ? stored.replace(' ', 'T') : stored;
}
