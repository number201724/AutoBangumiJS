/**
 * Password hashing — 1:1 port of the bcrypt helpers in module/security/jwt.py.
 *
 * bcrypt only uses the first 72 bytes; passlib silently truncated, bcrypt 5.x
 * raises. Python truncates raw bytes (`password.encode("utf-8")[:72]`), which
 * may split a multi-byte character. bcryptjs only accepts strings (UTF-8
 * encoded internally), so we truncate at a character boundary within 72 bytes
 * — identical for every password whose 72-byte prefix is valid UTF-8 (in
 * practice, all of them; only a >72-byte password split mid-character differs).
 */
import bcrypt from 'bcryptjs';

function truncatePassword(password: string): string {
  const bytes = Buffer.from(password, 'utf-8');
  if (bytes.length <= 72) return password;
  // Back off from a mid-character cut: UTF-8 continuation bytes are 10xxxxxx.
  let end = 72;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf-8');
}

export function verifyPassword(plainPassword: string, hashedPassword: string): boolean {
  try {
    return bcrypt.compareSync(truncatePassword(plainPassword), hashedPassword);
  } catch {
    return false;
  }
}

export function getPasswordHash(password: string): string {
  return bcrypt.hashSync(truncatePassword(password), 10);
}
