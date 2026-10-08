/**
 * Lazy require helper for composition roots that must not statically depend
 * on heavy/cyclic modules. Callers supply the expected shape as T.
 */
export function lazyRequire<T>(path: string): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path) as T;
}
