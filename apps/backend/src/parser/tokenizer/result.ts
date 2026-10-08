/**
 * Domain result returned by the release-title tokenizer.
 *
 * 物理定义在 ../types.ts（与 Episode 等共享契约放在一起）；本文件按 Python
 * 的 tokenizer/result.py 路径原地重导出。
 */

export {
  MediaType,
  ReleaseKind,
  type ParsedRelease,
  makeParsedRelease,
  primaryTitle,
  computeIsMixedCollection,
} from '../types';
