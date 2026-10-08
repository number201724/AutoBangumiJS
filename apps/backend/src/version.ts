/**
 * Mirrors module/__version__.py — CI builds generate this file with the real
 * version; in the repository/dev environment it falls back to DEV_VERSION.
 *
 * Declared as `string` (not a literal type) so build-time sed replacement of
 * the value never makes `VERSION === 'DEV_VERSION'` comparisons type-error.
 */
export const VERSION: string = 'DEV_VERSION';
